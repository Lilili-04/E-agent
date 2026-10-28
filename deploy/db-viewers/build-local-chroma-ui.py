"""Build the same verified frontend archive as the DGX viewer, labeled for local use."""
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request


def main():
    repo = Path(__file__).resolve().parents[2]
    dockerfile = (repo / 'deploy/db-viewers/Dockerfile.gateway').read_text(encoding='utf-8')
    match = re.search(r'ADD --checksum=sha256:([0-9a-f]{64}) (https://codeload.github.com/\S+) /tmp/ui.tar.gz', dockerfile)
    if not match:
        raise ValueError('Pinned frontend archive is missing from Dockerfile.gateway')
    expected, url = match.groups()
    root = repo / '.dsh-build/local-chroma-ui'
    root.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as response:
        raw = response.read()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('Frontend archive SHA256 mismatch')
    archive = root / 'source.tar.gz'
    archive.write_bytes(raw)
    source = root / 'source'
    source.mkdir(exist_ok=True)
    with tarfile.open(archive) as package:
        for member in package.getmembers():
            target = (source / member.name).resolve()
            if not target.is_relative_to(source.resolve()):
                raise ValueError('Archive member escapes source directory')
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(member) as content:
                    target.write_bytes(content.read())
            else:
                raise ValueError('Unsupported archive member type')
    app = source / ('chromadb-ui-' + url.rsplit('/', 1)[1])
    subprocess.run(['node', str(repo / 'deploy/db-viewers/prepare-ui.mjs'), str(app / 'src/App.vue'), 'local'], check=True)
    npm = shutil.which('npm.cmd') or shutil.which('npm')
    if not npm:
        raise ValueError('Install Node.js and npm first')
    subprocess.run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=app, check=True)
    subprocess.run([npm, 'run', 'build'], cwd=app, check=True)
    shutil.copytree(app / 'dist', root / 'dist', dirs_exist_ok=True)
    shutil.copyfile(app / 'LICENSE', root / 'dist/CHROMADB_UI_LICENSE.txt')
    print('Local Chroma UI ready:', root / 'dist')


if __name__ == '__main__':
    main()
