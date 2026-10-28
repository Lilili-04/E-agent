"""Exercise the local read gateway with isolated HTTP ports and no real database."""
from functools import partial
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

SPEC = importlib.util.spec_from_file_location('viewer', Path(__file__).with_name('local-chroma.py'))
viewer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(viewer)


class Collection:
    id, name = 'collection1', 'local-documents'
    metadata = {'dimension': 4}
    configuration = {'hnsw': {'space': 'cosine'}}

    def count(self):
        return 1

    def get(self, **kwargs):
        return {'ids': ['a'], 'metadatas': [{'region': '全国'}], 'documents': ['原文'], 'embeddings': [[1., 0., 0., 0.]]}

    def query(self, **kwargs):
        return {'ids': [['a']], 'distances': [[0.]], 'metadatas': [[{'region': '全国'}]]}


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = viewer.Store.__new__(viewer.Store)
        self.store.manifest = {'dimension': 4}
        self.store.collections = {'collection1': Collection()}
        self.store.lock = threading.Lock()
        handler = partial(viewer.Handler, store=self.store, directory=self.temp.name)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.worker = threading.Thread(target=self.server.serve_forever)
        self.worker.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        self.temp.cleanup()

    def request(self, path, method='GET', body=None):
        raw = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=raw, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_collection_listing_and_bounded_record_reads(self):
        status, data = self.request(viewer.BASE)
        self.assertEqual(status, 200)
        self.assertEqual(data[0]['name'], 'local-documents')
        status, data = self.request(viewer.BASE + '/collection1/get', 'POST', {'include': ['embeddings']})
        self.assertEqual(status, 200)
        self.assertEqual(data['embeddings'][0], [1., 0., 0., 0.])

    def test_every_write_verb_and_mutation_endpoint_is_blocked(self):
        for endpoint in ['', '/add', '/upsert', '/update', '/delete', '/reset']:
            self.assertEqual(self.request(viewer.BASE + '/collection1' + endpoint, 'POST', {})[0], 403)
        for method in ['DELETE', 'PUT', 'PATCH']:
            self.assertEqual(self.request(viewer.BASE + '/collection1', method, {})[0], 403)
        self.assertEqual(self.store.collections['collection1'].count(), 1)

    def test_read_requests_cannot_smuggle_write_parameters_or_uri_loading(self):
        for body in [{'documents': ['changed']}, {'include': ['data']}, {'limit': 501},
                     {'ids': ['a'] * 501}, {'offset': -1}, {'limit': True}]:
            self.assertEqual(self.request(viewer.BASE + '/collection1/get', 'POST', body)[0], 400)

    def test_vector_queries_and_invalid_inputs(self):
        endpoint = viewer.BASE + '/collection1/query'
        self.assertEqual(self.request(endpoint, 'POST', {'query_embeddings': [[1., 0., 0., 0.]]})[0], 200)
        for body in [{'query_texts': ['do not auto-embed']}, {'query_embeddings': [[1., 0.]]},
                     {'query_embeddings': [[0., 0., 0., 0.]]}, {'query_embeddings': [[float('nan')] * 4]}]:
            self.assertEqual(self.request(endpoint, 'POST', body)[0], 400)

    def test_other_collections_and_traversal_endpoints_are_rejected(self):
        self.assertEqual(self.request(viewer.BASE + '/unknown/count')[0], 404)
        self.assertEqual(self.request('/api/v2/reset', 'POST', {})[0], 403)
        self.assertEqual(self.request(viewer.BASE + '/collection1%2Fupdate', 'POST', {})[0], 403)


if __name__ == '__main__':
    unittest.main()
