"""Offline release validation, rollback, and resumable index construction against private SQLite fixtures."""
import copy
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='policy-release-')
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.database = self.root / 'policy-build-a.sqlite'
        self.text = '第一条 🌱' + '养殖场应当妥善处理粪水，不得直接排入河流。' * 80
        db = sqlite3.connect(self.database)
        try:
            db.executescript('''
              CREATE TABLE build_manifest(singleton,schema_version,build_id,corpus_hash,source_count,unit_count);
              INSERT INTO build_manifest VALUES(1,1,'build-a','corpus-a',1,1);
              CREATE TABLE sources(record_key,source_hash);
              INSERT INTO sources VALUES('record-a','hash-a');
              CREATE TABLE metadata(record_key,title);
              INSERT INTO metadata VALUES('record-a','养殖污染治理条例');
              CREATE TABLE descriptions(record_key,description);
              CREATE TABLE content_units(record_key,unit_id,kind,text,line_start,section_path_json);
            ''')
            db.execute('INSERT INTO content_units VALUES(?,?,?,?,?,?)', ('record-a', 'unit-a', 'article', self.text, 3, '[]'))
            db.commit()
        finally:
            db.close()
        self.release = load('policy_release', 'release.py')
        self.collections = {}
        self.entries = {}
        self.calls = []
        self.builder = load('policy_builder', 'build-passages.py')
        for kind in ('document', 'passage'):
            self.build(kind)
        self.document = next(name for name in self.collections if name.startswith('policy-document-'))
        self.passage = next(name for name in self.collections if name.startswith('policy-passage-'))

    def request(self, url, body=None):
        self.calls.append((url, body))
        if url == 'http://fixture/embeddings':
            return {'data': [{'index': index, 'embedding': [1] + [0] * 2559} for index in range(len(body['input']))]}
        tail = url.split('/collections', 1)[1].strip('/')
        if not tail:
            name = body['name']
            self.collections[name] = {'id': name, 'dimension': 2560, 'metadata': body['metadata'], 'configuration_json': body['configuration']}
            self.entries[name] = {}
            return copy.deepcopy(self.collections[name])
        parts = tail.split('/')
        name = parts[1] if parts[0] == 'by-id' else parts[0]
        if name not in self.collections:
            import urllib.error
            raise urllib.error.HTTPError(url, 404, 'not found', {}, None)
        action = parts[-1]
        if action == 'count':
            return len(self.entries[name])
        if action == 'get':
            items = list(self.entries[name].items())[body.get('offset', 0):body.get('offset', 0) + body['limit']]
            return {'ids': [key for key, _ in items], 'metadatas': [item for _, item in items]}
        if action == 'upsert':
            self.entries[name].update(zip(body['ids'], body['metadatas']))
            return {}
        return copy.deepcopy(self.collections[name])

    def build(self, kind):
        with patch.object(self.builder, 'request', side_effect=self.request), patch('sys.argv', [
            'build-passages.py', '--database', str(self.database), '--embedding-url', 'http://fixture/embeddings',
            '--chroma-url', 'http://fixture', '--kind', kind, '--model-revision', 'weights-a',
        ]):
            self.builder.main()

    def validate(self):
        with patch.object(self.release, 'request', side_effect=self.request):
            return self.release.validate(self.database, 'http://fixture', self.document, self.passage)

    def test_builds_both_indexes_and_resumes_without_embedding_completed_records(self):
        before = len([url for url, _ in self.calls if url.endswith('/embeddings')])
        self.build('passage')
        self.assertEqual(before, len([url for url, _ in self.calls if url.endswith('/embeddings')]))
        self.assertEqual(self.validate()['modelRevision'], 'weights-a')

    def test_rejects_incomplete_index(self):
        self.entries[self.passage].pop(next(iter(self.entries[self.passage])))
        with self.assertRaisesRegex(ValueError, 'coverage is incomplete'):
            self.validate()

    def test_rejects_stale_hash_and_invalid_unicode_span(self):
        original = copy.deepcopy(self.entries[self.passage])
        first = next(iter(self.entries[self.passage]))
        self.entries[self.passage][first]['source_hash'] = 'old-hash'
        with self.assertRaisesRegex(ValueError, 'source association'):
            self.validate()
        self.entries[self.passage] = original
        self.entries[self.passage][first]['end'] = len(self.text) + 1
        with self.assertRaisesRegex(ValueError, 'source span'):
            self.validate()

    def test_rejects_different_model_revisions(self):
        self.collections[self.passage]['metadata']['model_revision'] = 'weights-b'
        with self.assertRaisesRegex(ValueError, 'revisions differ'):
            self.validate()

    def test_published_manifest_cannot_be_overwritten(self):
        manifest = self.root / 'release.json'
        self.release.atomic_write(manifest, 'first', replace=False)
        with self.assertRaises(FileExistsError):
            self.release.atomic_write(manifest, 'second', replace=False)
        self.assertEqual(manifest.read_text(encoding='utf-8'), 'first')
        self.assertEqual(list(self.root.glob('.policy-release-*')), [])

    def test_activation_and_rollback_validate_before_atomic_selection(self):
        manifest = self.root / 'release-a.json'
        manifest.write_text(json.dumps(self.validate()), encoding='utf-8')
        env = self.root / 'selected.env'
        with patch.object(self.release, 'request', side_effect=self.request):
            self.release.activate(manifest, 'http://fixture', env)
            previous = env.read_bytes()
            self.collections[self.passage]['metadata']['build_id'] = 'build-b'
            with self.assertRaises(ValueError):
                self.release.activate(manifest, 'http://fixture', env)
            self.assertEqual(previous, env.read_bytes())
            self.collections[self.passage]['metadata']['build_id'] = 'build-a'
            env.write_text('POLICY_DB_FILE=policy-build-b.sqlite\n', encoding='utf-8')
            self.release.activate(manifest, 'http://fixture', env)
            self.assertEqual(previous, env.read_bytes())
        self.assertEqual(list(self.root.glob('.policy-release-*')), [])


if __name__ == '__main__':
    unittest.main()
