import json, sqlite3, pathlib, urllib.request, urllib.error, hashlib, time, sys, math

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
    db = sqlite3.connect(pathlib.Path(DB).as_uri()+'?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    manifest = dict(db.execute('select * from build_manifest').fetchone())
    name = 'policy-passages-'+manifest['build_id']+'-qwen4b-v1'
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
    try: collection = request(BASE+'/'+name)
    except urllib.error.HTTPError as e:
        if e.code != 404: raise
        collection = request(BASE,{'name':name,'metadata':{'build_id':manifest['build_id'],'field':'passage','dimension':2560,'metric':'cosine','model':MODEL,'chunk_version':'chars1200-overlap120-v1'},'configuration':{'hnsw':{'space':'cosine'}}})
    actual=request(BASE+'/by-id/'+collection['id'])
    if actual['configuration_json']['hnsw']['space']!='cosine':raise RuntimeError('Passage index distance is not cosine')
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
            if len(emb)!=2560: raise RuntimeError('Wrong embedding dimensions')
            norm=math.sqrt(sum(a*a for a in emb));embeddings.append([a/norm for a in emb])
        request(target+'/upsert',{'ids':[x[0] for x in batch],'embeddings':embeddings,'metadatas':[x[2] for x in batch],'documents':[x[1] for x in batch]})
        if offset % (BATCH*32)==0: print(json.dumps({'done':offset+len(batch),'total':len(pending),'seconds':round(time.monotonic()-started,1)}),flush=True)
    count=request(target+'/count')
    if count!=len(chunks): raise RuntimeError('Incomplete passage index')
    path=pathlib.Path('/srv/e-agent/policy-api/passage-manifest.json')
    path.write_text(json.dumps({'collection':name,'count':count,'build_id':manifest['build_id'],'corpus_hash':manifest['corpus_hash'],'model':MODEL,'dimension':2560,'metric':'cosine','chunk_version':'chars1200-overlap120-v1'},indent=2))
    print(json.dumps({'complete':True,'collection':name,'count':count,'seconds':round(time.monotonic()-started,1)}),flush=True)
    db.close()

if __name__=='__main__':main()
