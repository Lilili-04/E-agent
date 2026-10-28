"""Run local graph QA regressions through the shipped headless profile; keep raw JSON logs."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--split', choices=['development', 'holdout', 'graph'], required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--patch', type=Path, default=Path('.dsh-build/policy-graph-headless.patch.yml'))
parser.add_argument('--workers', type=int, choices=[1, 2], default=1)
parser.add_argument('--ids', help='Optional comma-separated case IDs; omitted runs the whole split.')
args = parser.parse_args()
dataset = json.loads((ROOT / '.dsh-build/policy-eval-v1/testset.json').read_text(encoding='utf-8'))
graph_cases = [
    dict(id='G01', question='2005年版《放射性同位素与射线装置安全和防护条例》废止了哪一部旧条例，何时废止？请核对原文，不要把2019年文本当成事件发出版本。'),
    dict(id='G02', question='《北京市市容环境卫生条例》2002年版同时废止了哪些旧文件？请完整列出清单并说明日期。'),
    dict(id='G03', question='《云南省污染源自动监控管理办法（试行）》与2011年旧办法是什么关系？能否确定废止的绝对日期？请核对附件原文。'),
    dict(id='G04', question='请逐字给出《放射性同位素与射线装置安全和防护条例》2005年版第一条。缺少该版正文时不要使用2019年文本替代。'),
    dict(id='G05', question='《重点流域水环境综合治理中央预算内投资计划管理办法》废止了哪个文号的旧办法？能否直接用目录发布日期认定废止日期？'),
    dict(id='G06', question='仅根据云南省文件，读取《云南省污染源自动监控管理办法（试行）》第一条，并说明读取的是附件还是印发通知。'),
]
cases = graph_cases if args.split == 'graph' else [c for c in dataset['cases'] if c['split'] == ('保留集' if args.split == 'holdout' else '调试集')]
if args.ids:
    cases = [case for case in cases if case['id'] in args.ids.split(',')]
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
env = os.environ.copy()
env['DGX_QWEN36_API_KEY'] = (ROOT / '.dsh-build/qwen-api.key').read_text(encoding='utf-8').strip()
results = []
lock = threading.Lock()
sources = list((ROOT / 'packages/experimental/environment-policy/src').glob('v2-*.ts'))
(output / 'manifest.json').write_text(json.dumps(dict(split=args.split, cases=cases,
    source_hashes={str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
    testset_sha256=hashlib.sha256((ROOT / '.dsh-build/policy-eval-v1/testset.json').read_bytes()).hexdigest()), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

def run(case):
    started = time.time()
    log = output / (case['id'] + '.jsonl')
    with log.open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless',
            '--patch', str(args.patch), '--json', case['question']], cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT)
        try:
            code = process.wait(timeout=240)
            status = 'finished'
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            code, status = process.returncode, 'timeout'
    events = []
    for line in log.read_text(encoding='utf-8').splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    record = dict(id=case['id'], exit_code=code, status=status, seconds=round(time.time()-started, 2),
        event_count=len(events), final=[e for e in events if e.get('type') == 'final'])
    with lock:
        results.append(record)
        (output / 'status.json').write_text(json.dumps(sorted(results, key=lambda r: r['id']), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        print(json.dumps({k: v for k, v in record.items() if k != 'final'}, ensure_ascii=False), flush=True)
    return record

with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
    list(pool.map(run, cases))
