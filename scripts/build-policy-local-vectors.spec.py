"""Offline checks for legacy reuse and exact evidence positioning."""
import importlib.util
import base64
import json
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('vectors', Path(__file__).with_name('build-policy-local-vectors.py'))
vectors = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vectors)
QUERY_SPEC = importlib.util.spec_from_file_location('query_vectors', Path(__file__).with_name('query-policy-local-vectors.py'))
query_vectors = importlib.util.module_from_spec(QUERY_SPEC)
QUERY_SPEC.loader.exec_module(query_vectors)


class ReuseTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.execute('create table content_units(id,document_id,sequence,text,line_start,line_end)')
        self.db.executemany('insert into content_units values (?,?,?,?,?,?)', [
            ('u1', 'd1', 0, '前文\r\n', 1, 2), ('u2', 'd1', 1, '引用正文。\n', 3, 4)])
        self.doc = {'id': 'd1', 'title': '文件'}
        self.old = {'record_key': 'r1', 'text': '引用正文。', 'line_start': 1, 'line_end': 4}
        self.meta = {'record_key': 'r1', 'start': 0, 'end': 5}
        self.text = '标题：文件\n章节：章节\n正文：引用正文。'

    def test_legacy_snippet_maps_across_normalized_units(self):
        units, start, end = vectors.mapped_passage(self.db, self.doc, self.old, self.meta, self.text)
        self.assertEqual([u['id'] for u in units], ['u1', 'u2'])
        self.assertEqual((start, end), (3, 8))

    def test_changed_title_or_body_cannot_reuse_vector(self):
        for text in [self.text.replace('标题：文件', '标题：旧名'), self.text.replace('引用正文。', '错误正文。')]:
            self.assertIsNone(vectors.mapped_passage(self.db, self.doc, self.old, self.meta, text))

    def test_stale_record_and_invalid_offsets_are_rejected(self):
        for meta in [{**self.meta, 'record_key': 'other'}, {**self.meta, 'end': 99},
                     {**self.meta, 'start': -1}, {**self.meta, 'start': True}]:
            self.assertIsNone(vectors.mapped_passage(self.db, self.doc, self.old, meta, self.text))

    def test_missing_snippet_in_sqlite_is_rejected(self):
        self.db.execute('update content_units set text=? where id=?', ('不同原文', 'u2'))
        self.assertIsNone(vectors.mapped_passage(self.db, self.doc, self.old, self.meta, self.text))

    def test_partial_legacy_coverage_still_requires_new_vector(self):
        self.assertFalse(vectors.fully_covered(100, [(0, 40), (41, 100)]))
        self.assertFalse(vectors.fully_covered(100, [(0, 99)]))
        self.assertTrue(vectors.fully_covered(100, [(30, 100), (0, 40)]))

    def test_long_unicode_chunks_cover_entire_text(self):
        text = '中国😀' * 1000
        chunks = list(vectors.chunks(text))
        self.assertTrue(vectors.fully_covered(len(text), [(a, b) for a, b, _ in chunks]))
        for start, end, snippet in chunks:
            self.assertLessEqual(len(snippet), 1200)
            self.assertEqual(snippet, text[start:end])

    def test_only_whitespace_gaps_can_be_ignored_for_reuse(self):
        self.assertTrue(vectors.covered_text('\n原文。\n\n', [(1, 4)]))
        self.assertFalse(vectors.covered_text('\n原文。新增。\n', [(1, 4)]))
        self.assertFalse(vectors.covered_text('原文。', []))

    def test_invalid_vectors_cannot_enter_local_collection(self):
        for vector in [[1.0], [0.0] * 2560, [float('nan')] * 2560, [1e308] * 2560, [True] * 2560]:
            with self.assertRaises(ValueError):
                vectors.normalized(vector)

    def test_base64_transport_preserves_float32_values_and_rejects_truncation(self):
        raw = struct.pack('<2560f', *([1.] + [0.] * 2559))
        encoded = base64.b64encode(raw).decode('ascii')
        self.assertEqual(vectors.decode_embedding(encoded), [1.] + [0.] * 2559)
        for invalid in [[], 'not base64!', base64.b64encode(raw[:-4]).decode('ascii')]:
            with self.assertRaises(ValueError):
                vectors.decode_embedding(invalid)

    def test_query_rejects_wrong_region_hash_and_evidence(self):
        self.db.execute('create table documents(id,title,description,source_hash,region)')
        self.db.execute('insert into documents values (?,?,?,?,?)', ('d1', '文件', '摘要', 'hash', '江苏省'))
        text = self.text
        metadata = {'document_id': 'd1', 'region': '江苏省', 'source_hash': 'hash',
            'embedding_text_hash': vectors.digest(text), 'unit_ids': json.dumps(['u1', 'u2']),
            'sequence_start': 0, 'sequence_end': 1, 'text_start': 3, 'text_end': 8}
        self.assertEqual(query_vectors.check_record(self.db, metadata, text)[1], '引用正文。')
        for change in [{'region': '全国'}, {'source_hash': 'changed'}, {'text_end': 9},
                       {'unit_ids': json.dumps(['u2'])}, {'embedding_text_hash': 'wrong'}]:
            with self.assertRaises(ValueError):
                query_vectors.check_record(self.db, {**metadata, **change}, text)

    def test_chroma_reopens_from_a_unicode_working_directory(self):
        with tempfile.TemporaryDirectory(prefix='vector-path-', dir=Path.cwd() / '.dsh-build') as temp:
            work = Path(temp) / '中文目录'
            work.mkdir()
            code = '''
import importlib.util, pathlib, sys
import chromadb
from chromadb.config import Settings
spec=importlib.util.spec_from_file_location('builder',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
client=chromadb.PersistentClient(path=module.chroma_path(pathlib.Path('vectors').resolve()),
    settings=Settings(anonymized_telemetry=False))
collection=client.get_or_create_collection('unicode-persistence',embedding_function=None)
if sys.argv[2]=='write':
    collection.upsert(ids=[str(i) for i in range(1100)],embeddings=[[1.,0.]]*1100)
    assert list(pathlib.Path('vectors/chroma').rglob('header.bin'))
else:
    assert collection.count()==1100
    assert len(collection.query(query_embeddings=[[1.,0.]],n_results=1)['ids'][0])==1
'''
            script = str(Path(__file__).with_name('build-policy-local-vectors.py').resolve())
            for mode in ['write', 'read']:
                subprocess.run([sys.executable, '-X', 'utf8', '-c', code, script, mode],
                               cwd=work, check=True, capture_output=True, timeout=30)


if __name__ == '__main__':
    unittest.main()
