"""Build resumable local Chroma collections from the admitted SQLite snapshot.

Remote Chroma is read-only; the remote model only receives embedding requests.
SQLite staging checkpoints contain vectors so retries never require a full rebuild.
"""
import argparse
from array import array
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
import urllib.error
import urllib.request

DIMENSION = 2560
MODEL = 'qwen3-embedding-4b'
CHARS, OVERLAP = 1200, 120
VERSION = 'combined-local-vectors-v1'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def request(url, body=None):
    """Use explicit vectors only; never invoke Chroma's default embedding model."""
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
            with OPENER.open(req, timeout=240) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code < 500 or attempt == 4:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 4:
                raise
        time.sleep(2 ** attempt)


def normalized(values):
    if len(values) != DIMENSION or not all(type(v) in (int, float) and math.isfinite(v) for v in values):
        raise ValueError('Embedding must contain 2560 finite numbers')
    norm = math.sqrt(sum(v * v for v in values))
    if not norm or not math.isfinite(norm):
        raise ValueError('Embedding norm must be finite and nonzero')
    return [v / norm for v in values]


def embed(url, texts):
    data = request(url.rstrip('/') + '/v1/embeddings', {
        'model': MODEL, 'input': texts, 'encoding_format': 'base64',
    })['data']
    data.sort(key=lambda item: item['index'])
    if [item['index'] for item in data] != list(range(len(texts))):
        raise ValueError('Embedding response indices do not match inputs')
    return [decode_embedding(item['embedding']) for item in data]


def decode_embedding(value):
    """Decode OpenAI-compatible little-endian float32 without JSON float expansion."""
    if not isinstance(value, str):
        raise ValueError('Expected base64 embedding response')
    raw = base64.b64decode(value, validate=True)
    if len(raw) != DIMENSION * 4:
        raise ValueError('Base64 embedding byte count does not match dimension')
    values = array('f')
    values.frombytes(raw)
    if sys.byteorder != 'little':
        values.byteswap()
    return normalized(values)


def chunks(text):
    for start in range(0, len(text), CHARS - OVERLAP):
        end = min(start + CHARS, len(text))
        if start and end - start < OVERLAP:
            break
        yield start, end, text[start:end]


def document_input(doc):
    return '标题：' + doc['title'] + '\n内容概述：' + doc['description']


def norm_text(text):
    return text.replace('\r\n', '\n')


def chroma_path(root):
    """Windows HNSW file IO needs an ASCII path, even when Python handles Unicode."""
    path = os.path.relpath(Path(root) / 'chroma', Path.cwd())
    if os.name == 'nt' and not path.isascii():
        raise ValueError('Run from a directory giving Chroma an ASCII relative path; see local-vectors README')
    return path


def mapped_passage(db, doc, old, meta, saved_input):
    """Reject stale source, title, offset, or snippet; return exact SQLite positions."""
    start, end = meta.get('start'), meta.get('end')
    if not old or old['record_key'] != meta.get('record_key'):
        return None
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(old['text']):
        return None
    snippet = norm_text(old['text'][start:end])
    if not saved_input.startswith('标题：' + doc['title'] + '\n章节：') or '\n正文：' not in saved_input:
        return None
    if norm_text(saved_input.split('\n正文：', 1)[1]) != snippet:
        return None
    units = [dict(r) for r in db.execute(
        'select * from content_units where document_id=? and line_end>=? and line_start<=? order by sequence',
        (doc['id'], old['line_start'], old['line_end']))]
    joined = ''.join(norm_text(u['text']) for u in units)
    offset = joined.find(snippet)
    if offset < 0:
        return None
    return units, offset, offset + len(snippet)


def fully_covered(length, intervals):
    reached = 0
    for start, end in sorted(intervals):
        if start > reached:
            return False
        reached = max(reached, end)
    return reached >= length


def covered_text(text, intervals):
    """Whitespace outside saved legacy snippets does not require a new embedding."""
    reached = 0
    for start, end in sorted(intervals):
        if start > reached and text[reached:start].strip():
            return False
        reached = max(reached, end)
    return not text[reached:].strip()


def log(event, **fields):
    print(json.dumps({'event': event, **fields}, ensure_ascii=False), flush=True)


class Builder:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.output).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(Path(args.database).resolve().as_uri() + '?mode=ro', uri=True)
        self.db.row_factory = sqlite3.Row
        self.docs = {r['id']: dict(r) for r in self.db.execute('select * from documents')}
        self.compat = json.loads(Path(args.compatibility).read_text(encoding='utf-8'))
        self.source_hash = hashlib.sha256(Path(args.database).read_bytes()).hexdigest()
        self.build_id = 'combined-' + self.source_hash[:12] + '-' + VERSION
        self.stage = sqlite3.connect(self.root / 'staging.sqlite', timeout=60)
        self.stage.execute('pragma journal_mode=WAL')
        self.stage.row_factory = sqlite3.Row
        self.stage.executescript('''
            create table if not exists state(key text primary key,value text not null);
            create table if not exists records(
              id text primary key,kind text not null,text text not null,metadata text not null,
              vector blob,origin text not null,indexed integer not null default 0);
            create table if not exists coverage(unit_id text,start integer,end integer);
            create index if not exists records_pending on records(kind,indexed);
        ''')
        previous = self.state('identity')
        identity = json.dumps({'database_sha256': self.source_hash, 'version': VERSION,
            'compatibility_sha256': hashlib.sha256(Path(args.compatibility).read_bytes()).hexdigest()})
        if previous is not None and previous != identity:
            raise ValueError('Output already belongs to another database or builder version')
        self.set_state('identity', identity)
        self.base = args.legacy_chroma_url.rstrip('/') + '/api/v2/tenants/default_tenant/databases/default_database/collections'

    def state(self, key):
        row = self.stage.execute('select value from state where key=?', (key,)).fetchone()
        return row[0] if row else None

    def set_state(self, key, value):
        self.stage.execute('insert or replace into state values (?,?)', (key, value))
        self.stage.commit()

    def metadata(self, doc):
        return {'document_id': doc['id'], 'title': doc['title'], 'region': doc['region'],
                'source_hash': doc['source_hash'], 'build_id': self.build_id}

    def add(self, key, kind, text, meta, vector=None, origin='embedding'):
        meta = {**meta, 'embedding_text_hash': digest(text), 'chunk_id': key}
        blob = array('f', normalized(vector)).tobytes() if vector is not None else None
        self.stage.execute('insert or ignore into records(id,kind,text,metadata,vector,origin) values (?,?,?,?,?,?)',
                           (key, kind, text, json.dumps(meta, ensure_ascii=False), blob, origin))

    def reuse(self, kind, name):
        checkpoint = 'legacy_' + kind
        if self.state(checkpoint) == 'complete':
            return
        collection = request(self.base + '/' + name)
        if collection['metadata'].get('build_id') != self.compat['legacy_build_id'] or collection['dimension'] != DIMENSION:
            raise ValueError('Legacy collection identity mismatch')
        target = self.base + '/' + collection['id']
        count = request(target + '/count')
        # The old release lacks a pinned model revision. Record empirical compatibility,
        # including samples from both ends and the middle, instead of inventing one.
        samples, sample_ids = [], []
        for offset in sorted({0, count // 2, max(count - 2, 0)}):
            page = request(target + '/get', {'limit': 2, 'offset': offset,
                'include': ['documents', 'embeddings', 'metadatas']})
            sample_ids.extend(page['ids'])
            fresh = embed(self.args.embedding_url, page['documents'])
            for old, new in zip(page['embeddings'], fresh):
                similarity = sum(a * b for a, b in zip(normalized(old), new))
                if similarity < 0.999:
                    raise ValueError(f'Legacy/current model compatibility failed: cosine={similarity}')
                samples.append(similarity)
        audit = {'collection': collection['name'], 'count': count, 'metadata': collection['metadata'],
                 'model_match': 'empirical-not-pinned-revision', 'sample_ids': sample_ids, 'sample_cosines': samples}
        (self.root / ('legacy-' + kind + '-audit.json')).write_text(json.dumps(audit, indent=2), encoding='utf-8')
        offset = int(self.state(checkpoint) or '0')
        while offset < count:
            page = request(target + '/get', {'limit': 128, 'offset': offset,
                'include': ['documents', 'metadatas', 'embeddings']})
            if not page['ids']:
                raise ValueError('Legacy pagination ended before collection count')
            for key, text, meta, vector in zip(page['ids'], page['documents'], page['metadatas'], page['embeddings']):
                mapped = self.compat['documents'].get(meta.get('record_key'))
                doc = self.docs.get(mapped['document_id']) if mapped else None
                if not doc or doc['source_hash'] != mapped['source_hash'] or doc['source_hash'] != meta.get('source_hash'):
                    continue
                if meta.get('build_id') != self.compat['legacy_build_id']:
                    continue
                metadata = {**self.metadata(doc), 'legacy_id': key, 'legacy_collection': name}
                if kind == 'document':
                    if text != document_input(doc):
                        continue
                    self.add(doc['id'], kind, text, metadata, vector, 'reused')
                else:
                    match = mapped_passage(self.db, doc, self.compat['units'].get(meta.get('unit_id')), meta, text)
                    if match is None:
                        continue
                    units, start, end = match
                    metadata.update(unit_ids=json.dumps([u['id'] for u in units]),
                        sequence_start=units[0]['sequence'], sequence_end=units[-1]['sequence'],
                        text_start=start, text_end=end)
                    self.add('legacy-' + digest(key)[:32], kind, text, metadata, vector, 'reused')
                    position = 0
                    for unit in units:
                        length = len(norm_text(unit['text']))
                        left, right = max(0, start - position), min(length, end - position)
                        if left < right:
                            self.stage.execute('insert into coverage values (?,?,?)', (unit['id'], left, right))
                        position += length
            offset += len(page['ids'])
            self.set_state(checkpoint, str(offset))
            if offset % 1024 == 0 or offset >= count:
                log('legacy_read', kind=kind, done=offset, total=count)
        if request(target + '/count') != count:
            raise ValueError('Legacy collection changed during export')
        self.set_state(checkpoint, 'complete')

    def prepare(self):
        if self.state('prepared'):
            return
        for doc in self.docs.values():
            self.add(doc['id'], 'document', document_input(doc), self.metadata(doc))
        coverage = {}
        for row in self.stage.execute('select * from coverage'):
            coverage.setdefault(row['unit_id'], []).append((row['start'], row['end']))
        for unit in self.db.execute("select * from content_units where kind!='heading' order by document_id,sequence"):
            text = norm_text(unit['text'])
            if len(text.strip()) < 30 or covered_text(text, coverage.get(unit['id'], [])):
                continue
            doc = self.docs[unit['document_id']]
            for start, end, snippet in chunks(text):
                key = 'chunk-' + digest(unit['id'] + ':' + str(start))[:32]
                metadata = {**self.metadata(doc), 'unit_ids': json.dumps([unit['id']]),
                    'sequence_start': unit['sequence'], 'sequence_end': unit['sequence'],
                    'text_start': start, 'text_end': end}
                context = '标题：' + doc['title'] + '\n章节：' + unit['section_path'] + '\n正文：' + snippet
                self.add(key, 'passage', context, metadata)
        self.set_state('prepared', 'true')
        log('prepared', counts=self.counts())

    def counts(self):
        return [dict(r) for r in self.stage.execute('''select kind,origin,count(*) as total,
            sum(vector is not null) as vectorized,sum(indexed) as indexed from records group by kind,origin''')]

    def build(self):
        import chromadb
        from chromadb.config import Settings
        # Resuming cannot silently mix a different model with cached vectors.
        samples = self.stage.execute('''select text,vector from records where vector is not null
            order by (origin='embedding') desc, id limit 3''').fetchall()
        fresh = embed(self.args.embedding_url, [r['text'] for r in samples]) if samples else []
        similarities = []
        for row, new in zip(samples, fresh):
            old = array('f'); old.frombytes(row['vector'])
            similarity = sum(a * b for a, b in zip(normalized(old), new))
            if similarity < 0.999:
                raise ValueError('Resume model no longer matches cached vectors')
            similarities.append(similarity)
        runtime = request(self.args.embedding_url.rstrip('/') + '/v1/models')
        (self.root / 'model-runtime-audit.json').write_text(json.dumps({
            'models': runtime, 'resume_probe_cosines': similarities}, indent=2), encoding='utf-8')
        self.client = chromadb.PersistentClient(path=chroma_path(self.root), settings=Settings(anonymized_telemetry=False))
        collections = {}
        for kind in ['document', 'passage']:
            collections[kind] = self.client.get_or_create_collection(
                name='policy-combined-' + kind + '-' + self.source_hash[:12], embedding_function=None,
                metadata={'build_id': self.build_id, 'database_sha256': self.source_hash,
                    'model': MODEL, 'dimension': DIMENSION, 'field': kind,
                    'input_version': 'title-description-v1' if kind == 'document' else 'title-section-body-v1',
                    'chunk_version': 'chars1200-overlap120-v1', 'model_match': 'legacy-empirical-audited'},
                configuration={'hnsw': {'space': 'l2' if kind == 'document' else 'cosine', 'num_threads': 4}})
            # Bulk construction avoids rewriting a growing dense index every 1,000 rows.
            collections[kind].modify(configuration={'hnsw': {'num_threads': 8, 'sync_threshold': 10000}})
        # Persist every computed batch before Chroma indexing. Repeated upserts are idempotent.
        for kind, collection in collections.items():
            batch_no = 0
            model_seconds, index_seconds = 0.0, 0.0
            while True:
                if (self.root / 'STOP').exists():
                    self.report(collections, False)
                    log('stopped_at_checkpoint', counts=self.counts())
                    return
                rows = self.stage.execute('select * from records where kind=? and indexed=0 limit ?',
                                          (kind, self.args.index_batch_size)).fetchall()
                if not rows:
                    break
                missing = [r for r in rows if r['vector'] is None]
                started = time.monotonic()
                for offset in range(0, len(missing), self.args.batch_size):
                    batch = missing[offset:offset + self.args.batch_size]
                    values = embed(self.args.embedding_url, [r['text'] for r in batch])
                    self.stage.executemany('update records set vector=? where id=?',
                        [(array('f', v).tobytes(), r['id']) for r, v in zip(batch, values)])
                    self.stage.commit()
                model_seconds += time.monotonic() - started
                vectors = []
                for row in rows:
                    blob = self.stage.execute('select vector from records where id=?', (row['id'],)).fetchone()[0]
                    values = array('f'); values.frombytes(blob); vectors.append(list(values))
                started = time.monotonic()
                collection.upsert(ids=[r['id'] for r in rows], embeddings=vectors,
                    documents=[r['text'] for r in rows], metadatas=[json.loads(r['metadata']) for r in rows])
                index_seconds += time.monotonic() - started
                self.stage.executemany('update records set indexed=1 where id=?', [(r['id'],) for r in rows])
                self.stage.commit()
                batch_no += 1
                if batch_no % 20 == 0:
                    self.report(collections, False)
                    log('indexing', kind=kind, counts=self.counts(),
                        model_seconds=round(model_seconds, 2), index_seconds=round(index_seconds, 2))
            expected = self.stage.execute('select count(*) from records where kind=?', (kind,)).fetchone()[0]
            if collection.count() != expected:
                raise ValueError('Chroma/staging count mismatch')
            log('collection_complete', kind=kind, count=expected)
        self.report(collections, True)

    def report(self, collections, complete):
        report = {'complete': complete, 'build_id': self.build_id, 'database_sha256': self.source_hash,
            'database': str(Path(self.args.database).resolve()), 'chroma_path': str(self.root / 'chroma'),
            'model': MODEL, 'dimension': DIMENSION, 'builder_version': VERSION,
            'metrics': {'document': 'l2', 'passage': 'cosine'}, 'offset_unit': 'unicode_code_point',
            'normalization': 'l2-unit', 'index_threads': 8, 'bulk_sync_threshold': 10000,
            'counts': self.counts(), 'collections': {k: c.name for k, c in collections.items()},
            'model_identity': 'Old collection has no pinned revision; reuse guarded by input/source checks and six current-model probes per collection.'}
        pending = self.root / 'manifest.pending.json'
        pending.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        pending.replace(self.root / 'manifest.json')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--compatibility', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--embedding-url', default='http://127.0.0.1:59329')
    parser.add_argument('--legacy-chroma-url', default='http://127.0.0.1:59330')
    parser.add_argument('--legacy-document-collection', default='policy-national-6bc6ed338ca5b809-combined')
    parser.add_argument('--legacy-passage-collection', default='policy-passages-build-96304174ffd64d27c759a3bc-qwen4b-v1')
    parser.add_argument('--batch-size', type=int, default=64)
    parser.add_argument('--index-batch-size', type=int, default=512)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 128:
        parser.error('--batch-size must be between 1 and 128')
    if not 1 <= args.index_batch_size <= 2048:
        parser.error('--index-batch-size must be between 1 and 2048')
    builder = Builder(args)
    builder.reuse('document', args.legacy_document_collection)
    builder.reuse('passage', args.legacy_passage_collection)
    builder.prepare()
    builder.build()


if __name__ == '__main__':
    main()
