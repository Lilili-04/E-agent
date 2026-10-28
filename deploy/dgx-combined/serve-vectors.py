"""Serve the admitted Chroma collections through the existing read-only adapter."""
import importlib.util
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location('policy_vectors', '/app/deploy/db-viewers/local-chroma.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
store = module.Store(Path('/release/vectors'))
server = ThreadingHTTPServer(('127.0.0.1', 18104), partial(module.Handler, store=store, directory='/tmp'))
try:
    server.serve_forever()
finally:
    server.server_close()
