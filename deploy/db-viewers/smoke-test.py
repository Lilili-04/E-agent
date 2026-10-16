"""Validate the real viewer containers against private fixture data and a fake Chroma server."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from prepare import create_login


def command(arguments, **options):
    return subprocess.run(arguments, check=True, text=True, **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true', help='Build the two images before testing.')
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parent
    project = 'viewers-smoke-' + uuid.uuid4().hex[:12]
    network = project + '-retrieval'
    fixture = project + '-chroma'
    compose_env = os.environ.copy()
    for name in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']:
        compose_env.pop(name, None)
    with tempfile.TemporaryDirectory(prefix=project + '-') as directory:
        temporary = Path(directory)
        database = temporary / 'fixture.sqlite'
        with sqlite3.connect(database) as connection:
            connection.executescript("CREATE TABLE metadata(record_key TEXT PRIMARY KEY, title TEXT); INSERT INTO metadata VALUES ('fixture-record','Fixture policy');")
        database.chmod(0o444)
        digest = hashlib.sha256(database.read_bytes()).hexdigest()
        password = secrets.token_urlsafe(24)
        login = temporary / 'secrets' / 'viewers.htpasswd'
        create_login(login, 'viewer', password)
        # The same file must not be silently replaced on a repeated setup.
        try:
            create_login(login, 'viewer', password)
        except FileExistsError:
            pass
        else:
            raise AssertionError('Credential setup overwrote an existing login file.')
        settings = {
            'VIEWERS_BIND_ADDRESS': '127.0.0.1',
            'SQLITE_VIEWER_PORT': '0', 'CHROMA_VIEWER_PORT': '0',
            'POLICY_SQLITE_FILE': str(database), 'VIEWERS_HTPASSWD_FILE': str(login),
            'POLICY_RETRIEVAL_NETWORK': network, 'CHROMA_UPSTREAM': 'chroma:8000',
        }
        for name in ['VIEWERS_DATASETTE_IMAGE', 'VIEWERS_GATEWAY_IMAGE', 'VIEWERS_PYTHON_IMAGE', 'VIEWERS_NODE_IMAGE', 'VIEWERS_NGINX_IMAGE']:
            if name in os.environ:
                settings[name] = os.environ[name]
        # Environment interpolation must not replace fixture paths with an operator's production values.
        compose_env.update(settings)
        env_file = temporary / '.env'
        env_file.write_text('\n'.join(name + '=' + value for name, value in settings.items()) + '\n')
        compose = ['docker', 'compose', '--env-file', str(env_file), '-p', project, '-f', str(root / 'compose.yml')]

        def dc(*arguments, **options):
            return command([*compose, *arguments], env=compose_env, **options)

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        authorization = 'Basic ' + base64.b64encode(('viewer:' + password).encode()).decode()

        def request(base, path, method='GET', body=None, authenticated=True):
            headers = {'Authorization': authorization} if authenticated else {}
            if body is not None:
                headers['Content-Type'] = 'application/json'
            query = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
            try:
                with opener.open(query, timeout=8) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()

        command(['docker', 'network', 'create', network], capture_output=True)
        try:
            if arguments.build:
                dc('build', timeout=1200)
            config = json.loads(dc('config', '--format', 'json', capture_output=True).stdout)
            image = config['services']['datasette']['image']
            command([
                'docker', 'run', '-d', '--name', fixture, '--network', network, '--network-alias', 'chroma',
                '--read-only', '--tmpfs', '/tmp',
                '--mount', 'type=bind,src=' + str(root / 'tests' / 'chroma-fixture.py') + ',dst=/fixture.py,readonly',
                '--entrypoint', 'python', image, '/fixture.py',
            ], capture_output=True)
            deadline = time.monotonic() + 30
            while True:
                ready = subprocess.run(['docker', 'exec', fixture, 'python', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v2/heartbeat',timeout=2)"], capture_output=True)
                if ready.returncode == 0:
                    break
                if time.monotonic() >= deadline:
                    raise AssertionError('Chroma fixture did not become ready.')
                time.sleep(0.2)
            dc('up', '-d', '--wait', '--wait-timeout', '90', timeout=120)
            sqlite_url = 'http://' + dc('port', 'gateway', '8080', capture_output=True).stdout.strip()
            chroma_url = 'http://' + dc('port', 'gateway', '8081', capture_output=True).stdout.strip()
            for base in [sqlite_url, chroma_url]:
                assert request(base, '/', authenticated=False)[0] == 401, 'Unauthenticated viewer was accessible.'
                assert request(base, '/')[0] == 200, 'Authenticated viewer did not load.'
            status, body = request(sqlite_url, '/policy/metadata.json?_shape=array')
            assert status == 200 and json.loads(body)[0]['title'] == 'Fixture policy', (status, body[:300])
            status, _ = request(sqlite_url, '/policy?sql=' + urllib.parse.quote("UPDATE metadata SET title='changed'"))
            assert status in [400, 403], 'Datasette accepted a SQL write.'
            assert request(sqlite_url, '/', 'POST', {})[0] == 403
            prefix = '/api/v2/tenants/default_tenant/databases/default_database/collections'
            for path in ['/api/v2/heartbeat', '/api/v2/version', '/api/v2/tenants/default_tenant', '/api/v2/tenants/default_tenant/databases/default_database', prefix, prefix + '/fixture-collection/count']:
                assert request(chroma_url, path)[0] == 200, path
            assert request(chroma_url, prefix, authenticated=False)[0] == 401
            status, body = request(chroma_url, prefix + '/fixture-collection/get', 'POST', {'limit': 500, 'offset': 0, 'include': ['documents', 'metadatas']})
            assert status == 200 and json.loads(body)['ids'] == ['fixture-unit']
            assert request(chroma_url, prefix + '/fixture-collection/query', 'POST', {'query_embeddings': [[1.0, 0.0]], 'n_results': 1})[0] == 200
            for method, path in [
                ('POST', '/api/v2/reset'), ('POST', '/api/v1/reset'),
                ('POST', '/api/v2/tenants'), ('POST', prefix),
                ('PUT', prefix + '/fixture-collection'), ('DELETE', prefix + '/fixture-collection'),
                *[('POST', prefix + '/fixture-collection/' + operation) for operation in ['add', 'update', 'upsert', 'delete', 'fork', '%75pdate']],
            ]:
                status, _ = request(chroma_url, path, method, {})
                assert status == 403, (method, path, status)
            audit = json.loads(command(['docker', 'exec', fixture, 'python', '-c', "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/audit').read().decode())"], capture_output=True).stdout)
            assert all(item['authorization'] is None for item in audit), 'Viewer credentials reached Chroma.'
            assert all(item['method'] == 'GET' or item['method'] == 'POST' and item['path'].endswith(('/get', '/query')) for item in audit), 'A write reached Chroma.'
            assert hashlib.sha256(database.read_bytes()).hexdigest() == digest, 'SQLite fixture changed.'
            print('PASS: authenticated pages, SQLite browse/read-only, Chroma V2 reads/query, write rejection, credential isolation and unchanged database.', flush=True)
        except Exception:
            subprocess.run([*compose, 'logs', '--tail', '40'], env=compose_env, timeout=15)
            raise
        finally:
            down = subprocess.run([*compose, 'down', '--remove-orphans', '--timeout', '5'], env=compose_env, capture_output=True, text=True, timeout=45)
            removed = subprocess.run(['docker', 'rm', '-f', fixture], capture_output=True, text=True, timeout=20)
            network_removed = subprocess.run(['docker', 'network', 'rm', network], capture_output=True, text=True, timeout=20)
            if down.returncode or network_removed.returncode:
                raise RuntimeError('Viewer fixture cleanup failed: ' + down.stderr + network_removed.stderr)
            # docker rm may report no such container when setup failed before acquiring it.
            if removed.returncode and 'No such container' not in removed.stderr:
                raise RuntimeError('Chroma fixture cleanup failed: ' + removed.stderr)
            print('CLEANUP: private containers and networks removed.', flush=True)


if __name__ == '__main__':
    main()
