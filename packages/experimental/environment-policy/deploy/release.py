"""Validate a complete source/vector snapshot and atomically select it; never invoke Docker or rebuild indexes."""
import argparse
import json
import os
import pathlib
import re
import sqlite3
import tempfile
import urllib.parse
import urllib.request


def request(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}), timeout=30) as response:
        return json.load(response)


def atomic_write(path, value, replace=True):
    path = pathlib.Path(path)
    fd, pending = tempfile.mkstemp(prefix='.policy-release-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(pending, path)
        else:
            os.link(pending, path)
    finally:
        pathlib.Path(pending).unlink(missing_ok=True)


def validate(database, chroma_url, document_collection, passage_collection):
    database = pathlib.Path(database).resolve()
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+\.sqlite', database.name):
        raise ValueError('SQLite snapshot needs a portable .sqlite basename')
    db = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        manifest = dict(db.execute('SELECT * FROM build_manifest WHERE singleton=1').fetchone())
        sources = dict(db.execute('SELECT record_key, source_hash FROM sources'))
        units = {(r['record_key'], r['unit_id']): {'kind': r['kind'], 'size': len(r['text']), 'eligible': len(r['text'].strip()) >= 30}
                 for r in db.execute('SELECT record_key,unit_id,kind,text FROM content_units')}
    finally:
        db.close()
    if manifest['schema_version'] != 1 or len(sources) != manifest['source_count'] or len(units) != manifest['unit_count']:
        raise ValueError('incomplete or incompatible SQLite snapshot')
    prefix = chroma_url.rstrip('/') + '/api/v2/tenants/default_tenant/databases/default_database/collections'
    collections = {}
    revision = model = None
    for kind, name in [('documents', document_collection), ('passages', passage_collection)]:
        value = request(prefix + '/' + urllib.parse.quote(name, safe=''))
        metadata = value['metadata']
        metric = value['configuration_json']['hnsw']['space']
        if (value['dimension'] != 2560 or metadata.get('build_id') != manifest['build_id']
                or metadata.get('corpus_hash') != manifest['corpus_hash']
                or not all(isinstance(metadata.get(key), str) and metadata[key].strip() for key in ('model', 'model_revision', 'input_version'))
                or metadata.get('query_instruction_version') != 'environment-policy-query-v1'
                or metric not in ('l2', 'cosine') or kind == 'passages' and metric != 'cosine'):
            raise ValueError('collection metadata does not identify a compatible source/model release')
        if model is not None and (model != metadata['model'] or revision != metadata['model_revision']):
            raise ValueError('document and passage embedding revisions differ')
        model, revision = metadata['model'], metadata['model_revision']
        if kind == 'passages' and metadata.get('chunk_version') != 'chars1200-overlap120-v1':
            raise ValueError('unsupported passage splitting version')
        target = prefix + '/' + value['id']
        count = request(target + '/count')
        if isinstance(count, bool) or not isinstance(count, int) or count <= 0:
            raise ValueError('invalid or empty collection count')
        expected = set(sources) if kind == 'documents' else {
            (key[0], key[1], start, min(start + 1200, row['size']))
            for key, row in units.items() if row['kind'] in ('article', 'paragraph', 'list-item', 'generic-block') and row['eligible']
            for start in range(0, row['size'], 1080) if start == 0 or row['size'] - start >= 120
        }
        found = set()
        for offset in range(0, count, 500):
            page = request(target + '/get', {'include': ['metadatas'], 'limit': 500, 'offset': offset})
            if not page['ids'] or len(page['ids']) != len(page['metadatas']):
                raise ValueError('incomplete collection page')
            for item in page['metadatas']:
                key = item.get('record_key')
                if item.get('build_id') != manifest['build_id'] or item.get('source_hash') != sources.get(key) or key not in sources:
                    raise ValueError('stale or missing source association')
                identity = key if kind == 'documents' else (key, item.get('unit_id'), item.get('start'), item.get('end'))
                if identity not in expected or identity in found:
                    raise ValueError('invalid, duplicate, or out-of-range source span')
                found.add(identity)
        if found != expected or count != len(expected):
            raise ValueError('collection coverage is incomplete')
        collections[kind] = {'collection': name, 'count': count, 'metric': metric, 'inputVersion': metadata['input_version']}
    return {'formatVersion': 1, 'databaseFile': database.name, 'buildId': manifest['build_id'], 'corpusHash': manifest['corpus_hash'],
            'model': model, 'modelRevision': revision, 'dimension': 2560, 'chunkVersion': 'chars1200-overlap120-v1',
            'queryInstructionVersion': 'environment-policy-query-v1', **collections}


def activate(manifest_path, chroma_url, env_path):
    manifest_path = pathlib.Path(manifest_path).resolve()
    saved = json.loads(manifest_path.read_text(encoding='utf-8'))
    if saved.get('formatVersion') != 1 or not re.fullmatch(r'[a-zA-Z0-9_.-]+\.sqlite', saved.get('databaseFile', '')):
        raise ValueError('invalid release manifest')
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+\.json', manifest_path.name):
        raise ValueError('release manifest needs a portable .json basename')
    current = validate(manifest_path.parent / saved['databaseFile'], chroma_url, saved['documents']['collection'], saved['passages']['collection'])
    if current != saved:
        raise ValueError('release changed after validation; selection was not modified')
    atomic_write(env_path, f"POLICY_DB_FILE={saved['databaseFile']}\nPOLICY_RELEASE_MANIFEST_FILE=/app/data/{manifest_path.name}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('prepare')
    prepare.add_argument('--database', required=True)
    prepare.add_argument('--documents', required=True)
    prepare.add_argument('--passages', required=True)
    prepare.add_argument('--output', required=True)
    select = commands.add_parser('activate')
    select.add_argument('--manifest', required=True)
    select.add_argument('--env-output', required=True)
    for command in (prepare, select):
        command.add_argument('--chroma-url', required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        output = pathlib.Path(args.output).resolve()
        if output.exists() or output.parent != pathlib.Path(args.database).resolve().parent:
            raise ValueError('write a new manifest beside its immutable SQLite snapshot')
        result = validate(args.database, args.chroma_url, args.documents, args.passages)
        atomic_write(output, json.dumps(result, ensure_ascii=False, indent=2) + '\n', replace=False)
        print('Release validated; no deployment configuration changed.')
    else:
        activate(args.manifest, args.chroma_url, args.env_output)
        print('Release selection written; recreate only the retrieval API to load it.')


if __name__ == '__main__':
    main()
