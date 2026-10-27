"""Offline admission regressions for combined policy imports."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import openpyxl

SPEC = importlib.util.spec_from_file_location('combined', Path(__file__).with_name('prepare-policy-combined.py'))
combined = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(combined)


class ImportAdmission(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.base = self.root / 'national.sqlite'
        self.national = {'id': 'national-stable-id', 'title': '已修复的国家法律', 'document_number': None,
                         'standard_number': None, 'document_type': '法律', 'issuing_authority': '发布机关',
                         'region': '全国', 'publish_date': '2020-01-01', 'effective_date': '2020-06-01',
                         'legal_status': '目录状态', 'description': '保留修复后的摘要', 'full_text': '第一条原文。\r\n',
                         'pdf_path': None, 'markdown_path': 'unchanged/full.md', 'source_hash': 'unchanged-hash', 'text_status': 'complete'}
        c = sqlite3.connect(self.base)
        c.execute('create table documents (' + ','.join(k + ' TEXT' for k in self.national) + ')')
        c.execute('pragma user_version=2')
        c.execute('insert into documents values (' + ','.join('?' for _ in self.national) + ')', list(self.national.values()))
        c.commit(); c.close()
        self.path = 'provincial/32_江苏省/' + 'a' * 24 + '_江苏省污染管理办法__正文/extracted/full.md'
        p = self.root / 'policy_md' / self.path
        p.parent.mkdir(parents=True)
        self.text = '第一条 污染物应当处理。\r\n' * 20
        p.write_bytes(self.text.encode())
        self.result_path = self.root / 'results/one.json'
        self.result_path.parent.mkdir()
        self.result = {'title': '江苏省污染管理办法', 'description': '原文摘要', 'main_text': self.text}
        self.write(self.result_path, self.result)
        evidence = {'source_path': self.path, 'source_hash': combined.digest(self.text),
                    'citations': [{'quote': '第一条', 'startOffset': 0, 'endOffset': 3}]}
        self.write(self.result_path.with_suffix('.evidence.json'), evidence)
        self.meta = {'source_path': self.path, 'source_hash': combined.digest(self.text), 'status': 'complete',
                     'coverage': 'agent_read_all_pages', 'result_hash': combined.digest(self.result_path.read_text('utf-8')),
                     'evidence_hash': combined.digest(self.result_path.with_suffix('.evidence.json').read_text('utf-8'))}
        self.write(self.result_path.with_suffix('.meta.json'), self.meta)
        self.item = {'source_path': self.path, 'source_id': 'one', 'source_hash': combined.digest(self.text),
                     'result_path': 'results/one.json', 'evidence_path': 'results/one.evidence.json', 'quality_flags': []}
        self.index = self.root / 'artifacts/provincial-extraction/descriptions-index.json'
        self.index.parent.mkdir(parents=True)
        self.write(self.index, {'records': [self.item]})
        self.catalog([['江苏省', '江苏省污染管理办法', None, '目录效力', '2021-02-03']])

    def write(self, path, value):
        path.write_text(json.dumps(value, ensure_ascii=False) + '\n', encoding='utf-8')

    def catalog(self, rows):
        w = openpyxl.Workbook()
        s = w.active; s.title = '省级文件清单'
        s.append(['省级行政区', '标题', '文号', '效力状态', '发布日期'])
        for row in rows:
            s.append(row)
        w.save(self.root / '环保政策法规清单.xlsx'); w.close()

    def test_preserves_national_repairs_and_excludes_unmatched_without_opening_them(self):
        self.write(self.index, {'records': [self.item, {'source_path': 'provincial/unknown/no-match/full.md', 'source_id': 'excluded'}]})
        docs, audit = combined.prepare(self.root, self.base)
        self.assertEqual(docs[0], self.national)
        self.assertEqual(len(docs), 2)
        self.assertEqual(docs[1]['region'], '江苏省')
        self.assertEqual(docs[1]['full_text'], self.text)
        self.assertEqual(docs[1]['legal_status'], '目录效力')
        self.assertEqual(audit['exclusions'], {'unmatched_catalog': 1})

    def test_ambiguous_versions_are_excluded(self):
        self.catalog([['江苏省', '江苏省污染管理办法', '文号A', '状态', None], ['江苏省', '江苏省污染管理办法', '文号B', '状态', None]])
        docs, audit = combined.prepare(self.root, self.base)
        self.assertEqual(docs, [self.national])
        self.assertEqual(audit['exclusions'], {'ambiguous_catalog': 1})

    def test_stale_extraction_fails_instead_of_entering_the_import(self):
        (self.root / 'policy_md' / self.path).write_text('正文已经变化', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Extraction validation'):
            combined.prepare(self.root, self.base)

    def test_missing_citations_cannot_pass_even_with_fresh_hashes(self):
        p = self.result_path.with_suffix('.evidence.json')
        data = json.loads(p.read_text('utf-8'))
        data['citations'] = []
        self.write(p, data)
        self.meta['evidence_hash'] = combined.digest(p.read_text('utf-8'))
        self.write(self.result_path.with_suffix('.meta.json'), self.meta)
        with self.assertRaisesRegex(ValueError, 'Extraction validation'):
            combined.prepare(self.root, self.base)

    def test_catalog_ambiguity_cannot_be_resolved_by_borrowing_a_different_date(self):
        candidates = combined.match_catalog('provincial/32_江苏省/' + 'a' * 24 + '_江苏省污染管理办法__2021-02-03__正文/extracted/full.md',
                                             [{'标题': '江苏省污染管理办法', '发布日期': '2020-02-03'}])
        self.assertEqual(candidates, [])


if __name__ == '__main__':
    unittest.main()
