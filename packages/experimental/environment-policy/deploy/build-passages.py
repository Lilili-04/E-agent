"""Build a resumable document or passage index in a new collection; never switch the serving release."""
import argparse, json, sqlite3, pathlib, urllib.request, urllib.error, hashlib, time, math

DB = '/srv/e-agent/policy-data/policy-national-v1.sqlite'
EMBED = 'http://127.0.0.1:8000/v1/embeddings'
BASE = 'http://127.0.0.1:8002/api/v2/tenants/default_tenant/databases/default_database/collections'
MODEL = 'qwen3-embedding-4b'
CHARS = 1200
OVERLAP = 120
BATCH = 32

def request(url, body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                return json.load(res)
        except urllib.error.URLError as error:
            if isinstance(error, urllib.error.HTTPError) and error.code < 500:
                raise
            if attempt == 3:
                raise
            time.sleep(attempt + 1)

def main():
    global DB, EMBED, BASE, MODEL
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', default=DB)
    parser.add_argument('--embedding-url', default=EMBED)
    parser.add_argument('--chroma-url', default='http://127.0.0.1:8002')
    parser.add_argument('--model', default=MODEL)
    parser.add_argument('--model-revision', required=True, help='Pinned model weights revision, not a mutable model alias')
    parser.add_argument('--kind', choices=['document', 'passage'], default='passage')
    args = parser.parse_args()
    if not args.model_revision.strip():
        parser.error('--model-revision must name a pinned weights revision')
    DB, EMBED, MODEL = args.database, args.embedding_url, args.model
    BASE = args.chroma_url.rstrip('/') + '/api/v2/tenants/default_tenant/databases/default_database/collections'
    db = sqlite3.connect(pathlib.Path(DB).as_uri()+'?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    manifest = dict(db.execute('select * from build_manifest').fetchone())
    input_version = 'title-section-body-v1' if args.kind == 'passage' else 'title-description-overview-v1'
    chunk_version = f'chars{CHARS}-overlap{OVERLAP}-v1'
    model_key = hashlib.sha256((MODEL+'\n'+args.model_revision+'\n'+input_version+'\n'+chunk_version).encode()).hexdigest()[:12]
    name = 'policy-'+args.kind+'-'+manifest['build_id']+'-'+model_key
    rows = db.execute("select u.*,m.title,s.source_hash from content_units u join metadata m using(record_key) join sources s using(record_key) where u.kind in ('article','paragraph','list-item','generic-block') order by u.record_key,u.line_start").fetchall()
    chunks = []
    for row in rows:
        text = row['text']
        if len(text.strip()) < 30: continue
        for start in range(0,len(text),CHARS-OVERLAP):
            end = min(start+CHARS,len(text))
            if start > 0 and end-start < OVERLAP: break
            snippet = text[start:end]
            key = row['record_key']+':'+row['unit_id']+':'+str(start)
            metadata = {'record_key':row['record_key'],'unit_id':row['unit_id'],'source_hash':row['source_hash'],'build_id':manifest['build_id'],'start':start,'end':end,'title':row['title'] or ''}
            context = '标题：'+(row['title'] or '')+'\n章节：'+' / '.join(json.loads(row['section_path_json']))+'\n正文：'+snippet
            chunks.append((key,context,metadata))
    if args.kind == 'document':
        rows = db.execute('SELECT s.record_key,s.source_hash,m.title,d.description FROM sources s JOIN metadata m USING(record_key) LEFT JOIN descriptions d USING(record_key) ORDER BY s.record_key').fetchall()
        chunks = []
        for row in rows:
            body = db.execute("SELECT text FROM content_units WHERE record_key=? AND kind!='heading' ORDER BY line_start LIMIT 3", (row['record_key'],)).fetchall()
            context = '标题：'+(row['title'] or '')+'\n摘要：'+(row['description'] or '')+'\n正文概览：'+'\n'.join(item['text'] for item in body)[:2400]
            metadata = {'record_key':row['record_key'],'source_hash':row['source_hash'],'build_id':manifest['build_id']}
            chunks.append((row['record_key'],context,metadata))
    expected_metadata = {'build_id':manifest['build_id'],'corpus_hash':manifest['corpus_hash'],'field':args.kind,'dimension':2560,
                         'model':MODEL,'model_revision':args.model_revision,'input_version':input_version,'chunk_version':chunk_version,
                         'query_instruction_version':'environment-policy-query-v1'}
    metric = 'cosine' if args.kind == 'passage' else 'l2'
    try: collection = request(BASE+'/'+name)
    except urllib.error.HTTPError as e:
        if e.code != 404: raise
        collection = request(BASE,{'name':name,'metadata':expected_metadata,'configuration':{'hnsw':{'space':metric}}})
    actual=request(BASE+'/by-id/'+collection['id'])
    if actual['configuration_json']['hnsw']['space']!=metric or actual.get('metadata') != expected_metadata:
        raise RuntimeError('Existing index has incompatible model, corpus, input or distance settings')
    target = BASE+'/'+collection['id']
    known = set(request(target+'/get',{'include':[],'limit':max(len(chunks)+1,1)})['ids'])
    pending = [x for x in chunks if x[0] not in known]
    print(json.dumps({'collection':name,'total':len(chunks),'pending':len(pending)},ensure_ascii=False),flush=True)
    started=time.monotonic()
    for offset in range(0,len(pending),BATCH):
        batch=pending[offset:offset+BATCH]
        vectors=request(EMBED,{'model':MODEL,'input':[x[1] for x in batch],'encoding_format':'float'})['data']
        vectors.sort(key=lambda x:x['index'])
        embeddings=[]
        for v in vectors:
            emb=v['embedding']
            if len(emb)!=2560 or not all(isinstance(a,(int,float)) and math.isfinite(a) for a in emb): raise RuntimeError('Wrong embedding values or dimensions')
            norm=math.sqrt(sum(a*a for a in emb))
            if not norm: raise RuntimeError('Zero embedding')
            embeddings.append([a/norm for a in emb])
        request(target+'/upsert',{'ids':[x[0] for x in batch],'embeddings':embeddings,'metadatas':[x[2] for x in batch],'documents':[x[1] for x in batch]})
        if offset % (BATCH*32)==0: print(json.dumps({'done':offset+len(batch),'total':len(pending),'seconds':round(time.monotonic()-started,1)}),flush=True)
    count=request(target+'/count')
    if count!=len(chunks): raise RuntimeError('Incomplete passage index')
    # Only release.py publishes the validated pairing; this builder reports its new collection.
    print(json.dumps({'complete':True,'collection':name,'count':count,'kind':args.kind,'seconds':round(time.monotonic()-started,1)}),flush=True)
    db.close()

if __name__=='__main__':main()
