"""Isolated HTTP fixture that records unexpected Chroma writes and forwarded credentials."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

events = []
collection = {'id': 'fixture-collection', 'name': 'policy-fixture', 'metadata': {'build_id': 'fixture'}, 'dimension': 2}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_arguments):
        pass

    def reply(self, value, status=200):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def record(self):
        events.append({'method': self.command, 'path': self.path, 'authorization': self.headers.get('Authorization')})

    def do_GET(self):
        if self.path == '/audit':
            return self.reply(events)
        self.record()
        path = self.path.split('?')[0].rstrip('/')
        if path.endswith('/heartbeat'):
            return self.reply({'nanosecond heartbeat': 1})
        if path.endswith('/version'):
            return self.reply('fixture-v2')
        if path.endswith('/count'):
            return self.reply(1)
        if path.endswith('/collections'):
            return self.reply([collection])
        return self.reply({'name': 'default_database'})

    def do_POST(self):
        self.record()
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        payload = json.loads(raw or b'{}')
        if self.path.endswith('/get'):
            return self.reply({'ids': ['fixture-unit'], 'documents': ['Fixture policy source'], 'metadatas': [{'recordKey': 'fixture-record'}], 'embeddings': [[1.0, 0.0]]})
        if self.path.endswith('/query'):
            return self.reply({'ids': [['fixture-unit']], 'documents': [['Fixture policy source']], 'metadatas': [[{'recordKey': 'fixture-record'}]], 'distances': [[0.0]], 'embeddings': None})
        return self.reply({'unexpected_write': payload}, 201)

    def do_PUT(self):
        self.record()
        self.reply({'unexpected_write': True})

    do_DELETE = do_PUT
    do_PATCH = do_PUT


ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
