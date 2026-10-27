"""Version selection tests independent of the runtime search implementation."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('latest', Path(__file__).with_name('build-policy-latest.py'))
latest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(latest)


def version(id, date=None, body=True, title='测试法规'):
    return dict(id=id, title=title, document_ids=[id] if body else [], publish_date=date,
                source_text_status='complete' if body else 'history_only')


def select(versions, edges=None):
    graph = dict(regulations=[dict(id='r', title='测试法规', region='全国', aliases=[])], versions=versions,
                 relations=[dict(type='HAS_VERSION', **{'from': 'r', 'to': v['id']}) for v in versions] + (edges or []))
    return latest.build(graph, [v['id'] for v in versions])['entries'][0]


class LatestTests(unittest.TestCase):
    def test_later_version_without_body_never_falls_back(self):
        entry = select([version('old', '2010-01-01'), version('new', '2020-01-01', False)])
        self.assertEqual(entry['status'], 'missing_body')
        self.assertEqual(entry['document_ids'], [])

    def test_unknown_and_tied_dates_require_review(self):
        for versions in ([version('a'), version('b', '2020-01-01')],
                         [version('a', '2020-01-01'), version('b', '2020-01-01')]):
            self.assertEqual(select(versions)['status'], 'unresolved')

    def test_single_version_needs_no_invented_date(self):
        self.assertEqual(select([version('only')])['document_ids'], ['only'])

    def test_year_label_does_not_guess_order_inside_same_year(self):
        a = version('a', title='测试法规（2025年版）')
        self.assertEqual(select([a, version('b', '2024-12-31')])['version_id'], 'a')
        self.assertEqual(select([a, version('b', '2025-06-01')])['status'], 'unresolved')

    def test_date_relation_conflict_requires_review(self):
        entry = select([version('a', '2020-01-01'), version('b', '2010-01-01')],
                       [dict(type='REVISES', **{'from': 'b', 'to': 'a'})])
        self.assertEqual(entry['status'], 'unresolved')
        self.assertEqual(entry['reason'], 'date_relation_conflict')

    def test_only_whole_revision_orders_undated_versions(self):
        versions = [version('a'), version('b')]
        for kind, expected in [('AMENDS', 'unresolved'), ('REVISES', 'ready')]:
            self.assertEqual(select(versions, [dict(type=kind, **{'from': 'b', 'to': 'a'})])['status'], expected)


if __name__ == '__main__':
    unittest.main()
