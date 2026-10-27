"""Loopback-only Chroma V2 read API and the pinned DGX viewer frontend.

Only collections named by the completed local manifest are exposed. No write,
embedding-function, remote-image, or URI-loading operation is implemented.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import math
from pathlib import Path
import re
import threading
import time
from urllib.parse import unquote, urlsplit

BASE = '/api/v2/tenants/default_tenant/databases/default_database/collections'


class Store:
    def __init__(self, root):
        import chromadb
        from chromadb.config import Settings
        repo = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('vector_builder', repo / 'scripts/build-policy-local-vectors.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        self.manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        if not self.manifest['complete']:
            raise ValueError('Local vector build is incomplete')
        self.client = chromadb.PersistentClient(path=builder.chroma_path(root), settings=Settings(anonymized_telemetry=False))
        self.collections = {}
        for name in self.manifest['collections'].values():
            collection = self.client.get_collection(name, embedding_function=None)
            if collection.metadata['build_id'] != self.manifest['build_id']:
                raise ValueError('Collection build differs from local manifest')
            self.collections[str(collection.id)] = collection
        self.lock = threading.Lock()

    def describe(self, collection):
        return {'id': str(collection.id), 'name': collection.name, 'metadata': collection.metadata,
            'configuration_json': collection.configuration, 'dimension': self.manifest['dimension'],
            'tenant': 'default_tenant', 'database': 'default_database'}

    def read(self, path, body=None):
        """Route only explicit local read operations; unsupported methods never reach Chroma."""
        if body is None:
            if path == '/api/v2/heartbeat':
                return {'nanosecond heartbeat': time.time_ns()}
            if path == '/api/v2/version':
                return '1.3.5'
            if path == '/api/v2/tenants/default_tenant':
                return {'name': 'default_tenant'}
            if path == '/api/v2/tenants/default_tenant/databases/default_database':
                return {'id': 'default_database', 'name': 'default_database', 'tenant': 'default_tenant'}
            if path == BASE:
                return [self.describe(c) for c in self.collections.values()]
        match = re.fullmatch(re.escape(BASE) + r'/([^/]+)(?:/(count|get|query))?', path)
        if not match:
            raise PermissionError('Read-only viewer: endpoint is not allowed')
        key, operation = match.groups()
        collection = self.collections.get(key) or next((c for c in self.collections.values() if c.name == key), None)
        if collection is None:
            raise KeyError('Collection is not part of this local release')
        if body is None:
            if operation is None:
                return self.describe(collection)
            if operation == 'count':
                return collection.count()
            raise PermissionError('This read endpoint requires POST')
        if operation not in ('get', 'query'):
            raise PermissionError('Read-only viewer: writes are blocked')
        if not isinstance(body, dict):
            raise ValueError('Request body must be an object')
        allowed = {'ids', 'where', 'where_document', 'include'}
        allowed |= {'limit', 'offset'} if operation == 'get' else {'query_embeddings', 'n_results'}
        if set(body) - allowed:
            raise ValueError('Unsupported read parameter; provide stored vectors for query_embeddings')
        if 'ids' in body and (not isinstance(body['ids'], list) or len(body['ids']) > 500):
            raise ValueError('Read at most 500 IDs at a time')
        include = body.get('include', ['documents', 'metadatas'])
        if not isinstance(include, list) or not set(include) <= {'documents', 'metadatas', 'embeddings', 'distances', 'uris'}:
            raise ValueError('Unsupported include field')
        if operation == 'get':
            limit = body.get('limit', 500)
            offset = body.get('offset', 0)
            if type(limit) is not int or not 1 <= limit <= 500 or type(offset) is not int or offset < 0:
                raise ValueError('limit must be 1–500 and offset must be nonnegative')
            return collection.get(**{**body, 'limit': limit, 'offset': offset})
        count = body.get('n_results', 10)
        vectors = body.get('query_embeddings')
        if type(count) is not int or not 1 <= count <= 100:
            raise ValueError('n_results must be 1–100')
        if not isinstance(vectors, list) or not 1 <= len(vectors) <= 10:
            raise ValueError('Provide 1–10 query vectors')
        for vector in vectors:
            if not isinstance(vector, list) or len(vector) != self.manifest['dimension']:
                raise ValueError('Query vector dimension does not match collection')
            if not all(type(v) in (int, float) and math.isfinite(v) for v in vector) or not any(vector):
                raise ValueError('Query vectors must contain finite numbers and be nonzero')
        return collection.query(**body)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, store, directory, **kwargs):
        self.store = store
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def respond(self, status, value, head=False):
        raw = json.dumps(value, ensure_ascii=False,
                         default=lambda value: value.tolist()).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        if not head:
            self.wfile.write(raw)

    def api(self, body=None, head=False):
        path = unquote(urlsplit(self.path).path).rstrip('/')
        try:
            with self.store.lock:
                result = self.store.read(path, body)
            self.respond(200, result, head)
        except PermissionError as error:
            self.respond(403, {'error': 'ReadOnly', 'message': str(error)}, head)
        except KeyError as error:
            self.respond(404, {'error': 'NotFound', 'message': str(error)}, head)
        except (ValueError, TypeError) as error:
            self.respond(400, {'error': 'InvalidArgument', 'message': str(error)}, head)

    def do_GET(self):
        if urlsplit(self.path).path == '/healthz':
            return self.respond(200, {'status': 'ok', 'viewer': 'local-policy-chroma'})
        if self.path.startswith('/api/'):
            return self.api()
        return super().do_GET()

    def do_HEAD(self):
        if self.path.startswith('/api/'):
            return self.api(head=True)
        return super().do_HEAD()

    def do_POST(self):
        path = unquote(urlsplit(self.path).path).rstrip('/')
        if not re.fullmatch(re.escape(BASE) + r'/[^/]+/(get|query)', path):
            self.close_connection = True
            return self.respond(403, {'error': 'ReadOnly', 'message': 'Writes are blocked'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 2 * 1024 * 1024:
                raise ValueError('Request body must be 1 byte–2 MiB')
            body = json.loads(self.rfile.read(size))
            if body is None:
                raise ValueError('Request body must be an object')
        except (ValueError, UnicodeError) as error:
            self.close_connection = True
            return self.respond(400, {'error': 'InvalidArgument', 'message': str(error)})
        return self.api(body)

    def do_DELETE(self):
        self.close_connection = True
        self.respond(403, {'error': 'ReadOnly', 'message': 'Writes are blocked'})

    do_PUT = do_DELETE
    do_PATCH = do_DELETE

    def list_directory(self, path):
        self.send_error(403, 'Directory listing is disabled')
        return None


def main():
    repo = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=repo / 'data/policy-combined-local-vectors-r2')
    parser.add_argument('--ui', type=Path, default=repo / '.dsh-build/local-chroma-ui/dist')
    parser.add_argument('--port', type=int, default=18102)
    parser.add_argument('--stop-file', type=Path)
    args = parser.parse_args()
    # The API owns the store independently of the optional browser frontend.
    store = Store(args.root.resolve())
    handler = partial(Handler, store=store, directory=str(args.ui.resolve()))
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    server.timeout = 0.5
    print(f'Local read-only vector viewer: http://127.0.0.1:{server.server_port}/', flush=True)
    try:
        while not (args.stop_file and args.stop_file.exists()):
            server.handle_request()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
