"""Vendor a pinned official G6 browser bundle and its license, with npm integrity check."""
import base64,hashlib,io,json,tarfile,urllib.request
from pathlib import Path
VERSION='5.1.1'
EXPECTED='50bXxMUf4mChyOv4ePVeWZLwotih9VunKfp0a++Wofv/wCyY8fb9+CV2wouIBCOZnd5ydBRA4NNaX9yLJzqa2w=='
root=Path(__file__).resolve().parent/'vendor';root.mkdir(exist_ok=True)
url=f'https://registry.npmjs.org/@antv/g6/-/g6-{VERSION}.tgz'
with urllib.request.urlopen(url,timeout=60) as response:payload=response.read()
assert base64.b64encode(hashlib.sha512(payload).digest()).decode()==EXPECTED
with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as archive:
    for member,destination in [('package/dist/g6.min.js','g6-5.1.1.min.js'),('package/LICENSE','G6-LICENSE.txt')]:
        data=archive.extractfile(member).read();(root/destination).write_bytes(data)
manifest={'package':'@antv/g6','version':VERSION,'license':'MIT','source':url,'npm_integrity':'sha512-'+EXPECTED,
    'bundle_sha256':hashlib.sha256((root/'g6-5.1.1.min.js').read_bytes()).hexdigest()}
(root/'g6-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(manifest))
