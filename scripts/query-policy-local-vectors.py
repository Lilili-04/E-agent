"""Query local vectors with DGX embeddings and return only SQLite-backed evidence."""
import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3

SPEC = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-policy-local-vectors.py'))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def check_record(db, metadata, text):
    """Validate source identity and exact original evidence before displaying a hit."""
    doc = db.execute('select id,title,description,source_hash,region from documents where id=?',
                     (metadata['document_id'],)).fetchone()
    if not doc or doc['source_hash'] != metadata['source_hash'] or doc['region'] != metadata['region']:
        raise ValueError('Vector/document source or region mismatch')
    if metadata['embedding_text_hash'] != builder.digest(text):
        raise ValueError('Vector input checksum mismatch')
    if 'unit_ids' not in metadata:
        if text != builder.document_input(doc):
            raise ValueError('Document vector input differs from current title/description')
        return doc, doc['description']
    units = db.execute('''select * from content_units where document_id=? and sequence between ? and ?
        order by sequence''', (doc['id'], metadata['sequence_start'], metadata['sequence_end'])).fetchall()
    if [u['id'] for u in units] != json.loads(metadata['unit_ids']):
        raise ValueError('Vector unit sequence mismatch')
    joined = ''.join(builder.norm_text(u['text']) for u in units)
    start, end = metadata['text_start'], metadata['text_end']
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(joined):
        raise ValueError('Vector offsets outside original text')
    snippet = joined[start:end]
    if builder.norm_text(text.split('\n正文：', 1)[1]) != snippet:
        raise ValueError('Vector snippet differs from original text')
    return doc, snippet


def main():
    import chromadb
    import numpy as np
    from chromadb.config import Settings
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--question')
    parser.add_argument('--region', default='全国', help='Exact region name stored in SQLite')
    parser.add_argument('--only', action='store_true', help='Exclude national documents when a province is selected')
    parser.add_argument('--document-id')
    parser.add_argument('--kind', choices=['document', 'passage'], default='passage')
    parser.add_argument('--embedding-url', default='http://127.0.0.1:59329')
    parser.add_argument('--limit', type=int, default=5)
    parser.add_argument('--verify', action='store_true', help='Validate every indexed record without calling the model')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if not manifest['complete']:
        raise ValueError('Index build is incomplete')
    path = Path(manifest['database'])
    if builder.hashlib.sha256(path.read_bytes()).hexdigest() != manifest['database_sha256']:
        raise ValueError('SQLite snapshot changed since vector build')
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    client = chromadb.PersistentClient(path=builder.chroma_path(root), settings=Settings(anonymized_telemetry=False))
    if args.verify:
        stage = sqlite3.connect((root / 'staging.sqlite').as_uri() + '?mode=ro', uri=True)
        counts = {}
        document_coverage = {}
        for kind, name in manifest['collections'].items():
            collection = client.get_collection(name, embedding_function=None)
            seen = set()
            covered_documents = set()
            expected = {r[0] for r in stage.execute('select id from records where kind=?', (kind,))}
            for offset in range(0, collection.count(), 512):
                page = collection.get(limit=512, offset=offset, include=['metadatas', 'documents', 'embeddings'])
                for key, meta, text, vector in zip(page['ids'], page['metadatas'], page['documents'], page['embeddings']):
                    if key in seen or meta['build_id'] != manifest['build_id']:
                        raise ValueError('Duplicate vector or mismatched build')
                    seen.add(key)
                    covered_documents.add(meta['document_id'])
                    check_record(db, meta, text)
                    cached = stage.execute('select vector from records where id=?', (key,)).fetchone()
                    expected_vector = np.frombuffer(cached[0], dtype=np.float32) if cached else None
                    actual = np.asarray(vector, dtype=np.float32)
                    if actual.shape != (builder.DIMENSION,) or not np.isfinite(actual).all():
                        raise ValueError('Persisted vector has invalid dimensions or numbers')
                    if expected_vector is None or not np.allclose(actual, expected_vector, rtol=1e-5, atol=1e-6):
                        raise ValueError('Persisted vector differs from computed/reused staging vector')
            if seen != expected:
                raise ValueError('Chroma/staging ID sets differ')
            counts[kind] = len(seen)
            document_coverage[kind] = covered_documents
        all_documents = {r[0] for r in db.execute('select id from documents')}
        if document_coverage['document'] != all_documents:
            raise ValueError('File-level collection does not cover the admitted corpus')
        result = {'verified': True, 'vectors_checked': True, 'counts': counts,
                  'document_coverage': {k: len(v) for k, v in document_coverage.items()},
                  'documents_without_passage_vectors': sorted(all_documents - document_coverage['passage']),
                  'database_sha256': manifest['database_sha256']}
        (root / 'validation.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result))
        return
    if not args.question or not 1 <= args.limit <= 30:
        parser.error('Provide --question and --limit between 1 and 30, or use --verify')
    regions = [args.region] if args.only or args.region == '全国' else ['全国', args.region]
    known = {r[0] for r in db.execute('select distinct region from documents')}
    if not set(regions) <= known:
        parser.error('Region is not present in the admitted SQLite database')
    vector = builder.embed(args.embedding_url, [
        'Instruct: Retrieve Chinese environmental policy documents and passages relevant to the question.\nQuery: ' + args.question])[0]
    collection = client.get_collection(manifest['collections'][args.kind], embedding_function=None)
    channels = []
    for region in regions:
        filters = [{'build_id': manifest['build_id']}, {'region': region}]
        if args.document_id:
            filters.append({'document_id': args.document_id})
        response = collection.query(query_embeddings=[vector], n_results=args.limit,
            where={'$and': filters}, include=['documents', 'metadatas', 'distances'])
        channel = []
        for key, meta, text, distance in zip(response['ids'][0], response['metadatas'][0],
                                            response['documents'][0], response['distances'][0]):
            doc, snippet = check_record(db, meta, text)
            channel.append({'id': key, 'document_id': doc['id'], 'title': doc['title'],
                'region': doc['region'], 'distance': distance, 'snippet': snippet[:800]})
        channels.append(channel)
    # Equal per-region candidate budgets keep national hits from crowding out provinces.
    result = []
    for rank in range(args.limit):
        for channel in channels:
            if rank < len(channel):
                result.append(channel[rank])
    print(json.dumps({'question': args.question, 'regions': regions, 'hits': result[:args.limit]},
                     ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
