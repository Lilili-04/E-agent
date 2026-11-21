"""Read-only local graph viewer backed by the pilot Neo4j database."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlparse
import urllib.request

import hashlib
import os
DATABASE = Path(os.environ['POLICY_SQLITE_FILE'])
EXPECTED_SQLITE = os.environ['POLICY_SQLITE_SHA256']
def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()
def read_graph():
    raise ValueError('The separate legacy reference database is not deployed')

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ['POLICY_VIEWER_DATA'])


def read_sdk_graph(group='policy-sdk-pilot-v2'):
    """Fixed read queries only; keep SDK technical properties out of the business view."""
    statements = [
        # Project business fields inside Neo4j; never transfer embedding arrays to this viewer.
        {'statement': 'MATCH (n:Entity {group_id:$group}) RETURN n{.id,.title,.aliases,.region,.review_status,.review_reason,'
            '.document_ids,.document_type,.document_number,.issuer,.publish_date,.revision_date,.effective_date,.status_note,'
            '.adoption_date,.version_label,.source_text_status,.target_text_status,.evidence_refs,.identity_evidence} AS props, '
            'CASE WHEN n:Version THEN "Version" ELSE "Regulation" END AS kind ORDER BY n.id',
            'parameters': {'group': group}},
        {'statement': 'MATCH (a:Entity)-[r:RELATES_TO {group_id:$group}]->(b:Entity) '
            'RETURN r{.id,.date,.scope,.scope_text,.evidence,.source_refs,.review_status,.review_reason} AS props, '
            'r.name AS kind, a.id AS source, b.id AS target ORDER BY r.id',
            'parameters': {'group': group}},
    ]
    request = urllib.request.Request('http://127.0.0.1:17475/db/neo4j/tx/commit',
        json.dumps({'statements': statements}).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result.get('errors'):
        raise RuntimeError('SDK Neo4j read failed')
    def rows(item):
        return [dict(zip(item['columns'], row['row'])) for row in item['data']]
    nodes, edges = rows(result['results'][0]), rows(result['results'][1])
    fields = {'Regulation': ('id', 'title', 'aliases', 'region', 'review_status', 'review_reason'),
        'Version': ('id', 'title', 'document_ids', 'document_type', 'document_number', 'issuer',
            'publish_date', 'revision_date', 'effective_date', 'status_note', 'review_status', 'review_reason')}
    if group in ('policy-combined-v3', 'policy-combined-v4'):
        fields['Version'] += ('adoption_date', 'version_label', 'source_text_status', 'target_text_status',
                              'evidence_refs', 'identity_evidence')
    graph = {'nodes': [{**{key: node['props'].get(key) for key in fields[node['kind']]},
        'kind': node['kind']} for node in nodes], 'relations': []}
    for edge in edges:
        props = {key: edge['props'].get(key) for key in
            ('id', 'date', 'scope', 'scope_text', 'evidence', 'source_refs', 'review_status', 'review_reason')}
        props['source_refs'] = [json.loads(ref) for ref in props['source_refs'] or []]
        graph['relations'].append(dict(props, type=edge['kind'], **{'from': edge['source'], 'to': edge['target']}))
    return graph


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body, content_type='application/json; charset=utf-8'):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        static = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
            '/style.css': ('style.css', 'text/css'), '/g6-view.js': ('g6-view.js', 'text/javascript'),
            '/view-helpers.js': ('view-helpers.js', 'text/javascript'),
            '/vendor/g6-5.1.1.min.js': ('vendor/g6-5.1.1.min.js', 'text/javascript')}
        if url.path in static:
            filename, kind = static[url.path]
            self.respond(200, (ROOT / 'viewer' / filename).read_bytes(), kind + '; charset=utf-8')
            return
        try:
            if url.path.startswith('/api/historical/'):
                directory = DATA / 'graphiti-combined-v4'
                if not (directory/'progress.json').exists() or json.loads((directory/'progress.json').read_text('utf-8')).get('state') != 'complete':
                    self.respond(503, {'error': '历史事件修正版v4尚未完成写入；可切换到保留的v3'})
                    return
                if url.path == '/api/historical/graph':
                    self.respond(200, read_sdk_graph('policy-combined-v4'))
                elif url.path in ('/api/historical/summary', '/api/historical/source-gaps', '/api/historical/evaluation', '/api/historical/adjudications'):
                    name = {'/api/historical/summary':'summary.json', '/api/historical/source-gaps':'source-gaps.json',
                            '/api/historical/evaluation':'relation-evaluation.json', '/api/historical/adjudications':'adjudications.json'}[url.path]
                    self.respond(200, json.loads((directory/name).read_text('utf-8')))
                else:
                    self.respond(404, {'error':'页面不存在'})
                return
            if url.path.startswith('/api/corrected/'):
                directory = DATA / 'graphiti-combined-v3'
                if not (directory/'progress.json').exists() or json.loads((directory/'progress.json').read_text('utf-8')).get('state') != 'complete':
                    self.respond(503, {'error': '修正版v3尚未完成写入；可切换到保留的v2'})
                    return
                if url.path == '/api/corrected/graph':
                    self.respond(200, read_sdk_graph('policy-combined-v3'))
                elif url.path in ('/api/corrected/summary', '/api/corrected/source-gaps', '/api/corrected/evaluation'):
                    name = {'/api/corrected/summary':'summary.json', '/api/corrected/source-gaps':'source-gaps.json',
                            '/api/corrected/evaluation':'relation-evaluation.json'}[url.path]
                    self.respond(200, json.loads((directory/name).read_text('utf-8')))
                else:
                    self.respond(404, {'error':'页面不存在'})
                return
            if url.path.startswith('/api/reviewed/') or url.path == '/review-ledger.tsv':
                progress = json.loads((DATA / 'graphiti-combined-v2/progress.json').read_text('utf-8'))
                if progress.get('state') != 'complete':
                    self.respond(503, {'error': '审查修正版正在写入；已验证的合并初版仍可查看'})
                    return
            if url.path.startswith('/api/combined/'):
                progress = json.loads((DATA / 'graphiti-combined-v1/progress.json').read_text('utf-8'))
                if progress.get('state') != 'complete':
                    self.respond(503, {'error': '全国及省级合并图谱仍在建库；请查看已验证的国家级 v4'})
                    return
            if url.path.startswith('/api/national-v4/'):
                progress = json.loads((DATA / 'graphiti-national-v4/progress.json').read_text('utf-8'))
                if progress.get('state') != 'complete':
                    self.respond(503, {'error': '国家级 v4 建图尚未完成；请查看已验证的 v3'})
                    return
            if url.path == '/api/graph':
                self.respond(200, read_graph())
            elif url.path == '/api/sdk/graph':
                self.respond(200, read_sdk_graph())
            elif url.path == '/api/national/graph':
                self.respond(200, read_sdk_graph('policy-national-v1'))
            elif url.path == '/api/national-v2/graph':
                self.respond(200, read_sdk_graph('policy-national-v2'))
            elif url.path == '/api/national-v3/graph':
                self.respond(200, read_sdk_graph('policy-national-v3'))
            elif url.path == '/api/national-v4/graph':
                self.respond(200, read_sdk_graph('policy-national-v4'))
            elif url.path == '/api/combined/graph':
                self.respond(200, read_sdk_graph('policy-combined-v1'))
            elif url.path == '/api/reviewed/graph':
                self.respond(200, read_sdk_graph('policy-combined-v2'))
            elif url.path == '/api/reviewed/summary':
                self.respond(200, json.loads((DATA / 'graphiti-combined-v2/summary.json').read_text('utf-8')))
            elif url.path == '/api/reviewed/source-gaps':
                self.respond(200, json.loads((DATA / 'graphiti-combined-v2/source-gaps.json').read_text('utf-8')))
            elif url.path == '/api/reviewed/decisions':
                records = json.loads((DATA / 'review-all-1510-20261027/decisions.json').read_text('utf-8'))
                record_id = parse_qs(url.query).get('id', [''])[0]
                self.respond(200, [r for r in records if not record_id or record_id == r['original_id'] or record_id in r['result_ids']])
            elif url.path == '/review-ledger.tsv':
                self.respond(200, (DATA / 'review-all-1510-20261027/1510项审查台账.tsv').read_bytes(), 'text/tab-separated-values; charset=utf-8')
            elif url.path == '/api/national/reviews':
                self.respond(200, json.loads((DATA / 'graphiti-national-v1/review-queue.json').read_text('utf-8')))
            elif url.path == '/api/national-v2/reviews':
                self.respond(200, json.loads((DATA / 'graphiti-national-v2/review-queue.json').read_text('utf-8')))
            elif url.path == '/api/national-v3/reviews':
                self.respond(200, json.loads((DATA / 'graphiti-national-v3/review-queue.json').read_text('utf-8')))
            elif url.path == '/api/national-v4/reviews':
                self.respond(200, json.loads((DATA / 'graphiti-national-v4/review-queue.json').read_text('utf-8')))
            elif url.path == '/api/combined/reviews':
                self.respond(200, json.loads((DATA / 'graphiti-combined-v1/review-queue.json').read_text('utf-8')))
            elif url.path == '/api/national/summary':
                self.respond(200, json.loads((DATA / 'graphiti-national-v1/summary.json').read_text('utf-8')))
            elif url.path == '/api/national-v2/summary':
                self.respond(200, json.loads((DATA / 'graphiti-national-v2/summary.json').read_text('utf-8')))
            elif url.path == '/api/national-v3/summary':
                self.respond(200, json.loads((DATA / 'graphiti-national-v3/summary.json').read_text('utf-8')))
            elif url.path == '/api/national-v4/summary':
                self.respond(200, json.loads((DATA / 'graphiti-national-v4/summary.json').read_text('utf-8')))
            elif url.path == '/api/combined/summary':
                self.respond(200, json.loads((DATA / 'graphiti-combined-v1/summary.json').read_text('utf-8')))
            elif url.path == '/api/sdk/comparison':
                self.respond(200, json.loads((DATA / 'graphiti-sdk-v2/comparison.json').read_text('utf-8')))
            elif url.path == '/api/sdk/reviews':
                self.respond(200, json.loads((DATA / 'graphiti-sdk-v2/review-queue.json').read_text('utf-8')))
            elif url.path == '/api/manifest':
                self.respond(200, json.loads((DATA / 'manifest.json').read_text('utf-8')))
            elif url.path == '/api/source':
                document_id = parse_qs(url.query).get('id', [''])[0]
                if document_id.startswith('local-'):
                    supplements = json.loads((DATA / 'review-all-1510-20261027/supplemental-sources.json').read_text('utf-8'))
                    supplement = supplements.get(document_id)
                    if supplement is None:
                        self.respond(404, {'error': '该原件不在已审查证据清单中'})
                        return
                    if sha(DATA / supplement['path']) != supplement['source_hash']:
                        raise ValueError('Reviewed original changed')
                    self.respond(200, {'id': document_id, 'title': '本地原件证据：' + Path(supplement['path']).name,
                        'source_hash': supplement['source_hash'], 'full_text': supplement['full_text'], 'coverage': supplement['coverage']})
                    return
                audit = json.loads((DATA / 'source-audit.json').read_text('utf-8'))
                national = DATA / 'graphiti-national-v1/source-audit.json'
                if national.exists():
                    audit += json.loads(national.read_text('utf-8'))
                combined = DATA / 'graphiti-combined-v1/source-audit.json'
                if combined.exists() and (DATA / 'graphiti-combined-v1/progress.json').exists():
                    audit += json.loads(combined.read_text('utf-8'))
                source = next((x for x in audit if x['document_id'] == document_id), None)
                if source is None:
                    self.respond(404, {'error': '该来源不在已建图的本地语料中'})
                    return
                with closing(sqlite3.connect(DATABASE.resolve().as_uri() + '?mode=ro', uri=True)) as connection:
                    connection.row_factory = sqlite3.Row
                    row = connection.execute('SELECT id,title,source_hash,full_text FROM documents WHERE id=?', (document_id,)).fetchone()
                    if row is None or row['source_hash'] != source['source_hash']:
                        raise ValueError('Source identity changed')
                    self.respond(200, dict(row))
            else:
                self.respond(404, {'error': '页面不存在'})
        except (OSError, ValueError, RuntimeError) as error:
            self.log_error('%s', error)
            self.respond(503, {'error': '图数据库暂不可用，请检查本地 Neo4j 状态'})

    def do_POST(self):
        self.respond(405, {'error': '此查看器只提供读取接口'})

    do_PUT = do_POST
    do_DELETE = do_POST
    do_PATCH = do_POST


if __name__ == '__main__':
    if sha(DATABASE) != EXPECTED_SQLITE:
        raise ValueError('The source SQLite snapshot changed')
    print('Read-only graph viewer: http://127.0.0.1:18106/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 18106), Handler).serve_forever()
