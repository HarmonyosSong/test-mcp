"""重复 QA 实验：JSON vs MD-v3 投影，5 题型 × 3 次。
判分全部用 fixture 里算出的确定性标准答案。curl 3 并发。
"""
import json
import random
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, '/tmp')
from log_projection_v2 import make_result  # noqa: E402

result = make_result()
rows = []
for side in ('logcenter', 'cloud'):
    for gi, g in enumerate((result.get(side) or {}).get('results') or []):
        name = g.get('service') or g.get('topic')
        for e in g.get('logs') or []:
            rows.append((side, name, e))

# ---- 标准答案 ----
gt1 = sum(1 for _, _, e in rows if e['clickid'] == 'doTrade' and e['level'] == 'ERROR')
levels: dict[str, int] = {}
for _, _, e in rows:
    levels[e['level']] = levels.get(e['level'], 0) + 1
gt3 = levels
gt4 = min(e['ts'] for _, _, e in rows)
pick = rows[13][2]  # 固定取一条
gt2 = pick['traceId']
gt5 = sum(1 for side, name, e in rows if name == 'prod-topic-7')

questions = [
    {
        'id': 'q1-count-2field',
        'text': 'clickid 为 doTrade 且 level 为 ERROR 的日志一共有多少条？只回答数字。',
        'check': lambda a: str(gt1) in re.findall(r'\d+', a),
        'gt': gt1,
    },
    {
        'id': 'q2-lookup-trace',
        'text': f'eventId 为 {pick["eventId"]} 的那条日志，它的 traceId 是什么？只回答 traceId。',
        'check': lambda a: gt2 in a,
        'gt': gt2,
    },
    {
        'id': 'q3-level-dist',
        'text': '按 level 统计：ERROR、WARN、INFO 各有多少条日志？只按 "ERROR=x WARN=y INFO=z" 格式回答。',
        'check': lambda a: all(f'{k}={v}' in a.replace('，', ' ').replace(',', ' ') or re.search(rf'{k}\D{{0,4}}{v}\b', a) for k, v in gt3.items()),
        'gt': gt3,
    },
    {
        'id': 'q4-earliest-ts',
        'text': '全部日志里时间最早的一条，其 ts 字段是什么？只回答 ts 原值。',
        'check': lambda a: gt4 in a,
        'gt': gt4,
    },
    {
        'id': 'q5-group-count',
        'text': '云日志 prod-topic-7 这个分组里有多少条日志？只回答数字。',
        'check': lambda a: str(gt5) in re.findall(r'\d+', a),
        'gt': gt5,
    },
]

forms = {
    'json': open('/tmp/log_fixture.json').read(),
    'md-v3': open('/tmp/log_projection_v3.md').read(),
}

KEY = json.load(open('/Users/tal/Desktop/HarmonyOS_Agent/.data/model-config.json'))['api_key']
RUNS = 3
lock = threading.Lock()
results = []


def call(form, q, run):
    body = json.dumps({
        'model': 'deepseek-flash',
        'messages': [{'role': 'user', 'content': forms[form] + '\n\n问题：' + q['text']}],
        'max_tokens': 8000,
    }, ensure_ascii=False)
    path = f'/tmp/qa_req_{form}_{q["id"]}_{run}.json'
    open(path, 'w').write(body)
    for attempt in (1, 2):
        try:
            out = subprocess.run(
                ['curl', '-sS', '--http1.1', '--max-time', '300',
                 'https://api.deepseek.com/chat/completions',
                 '-H', 'Content-Type: application/json',
                 '-H', f'Authorization: Bearer {KEY}',
                 '--data', f'@{path}'],
                capture_output=True, text=True, timeout=320)
            data = json.loads(out.stdout)
            msg = data['choices'][0]['message']
            answer = msg.get('content') or ''
            usage = data.get('usage') or {}
            ok = q['check'](answer)
            with lock:
                results.append({
                    'form': form, 'q': q['id'], 'run': run, 'ok': ok,
                    'answer': answer[:80],
                    'prompt_tokens': usage.get('prompt_tokens'),
                    'reasoning_tokens': (usage.get('completion_tokens_details') or {}).get('reasoning_tokens'),
                })
            return
        except Exception as exc:
            if attempt == 2:
                with lock:
                    results.append({'form': form, 'q': q['id'], 'run': run, 'ok': False,
                                    'answer': f'ERROR: {exc}', 'prompt_tokens': None, 'reasoning_tokens': None})


tasks = [(f, q, r) for f in forms for q in questions for r in range(1, RUNS + 1)]
with ThreadPoolExecutor(max_workers=3) as pool:
    pool.map(lambda t: call(*t), tasks)

print(f'{"form":<7}{"question":<18}{"run":<5}{"ok":<4}{"reason_tok":<11}answer')
for r in sorted(results, key=lambda x: (x['form'], x['q'], x['run'])):
    print(f"{r['form']:<7}{r['q']:<18}{r['run']:<5}{str(r['ok']):<4}{str(r['reasoning_tokens']):<11}{r['answer'][:60]!r}")

json.dump(results, open('/tmp/qa_results.json', 'w'), ensure_ascii=False, indent=1)
print('\n=== 汇总 ===')
for form in forms:
    rs = [r for r in results if r['form'] == form]
    ok = sum(1 for r in rs if r['ok'])
    pt = [r['prompt_tokens'] for r in rs if r['prompt_tokens']]
    rt = [r['reasoning_tokens'] for r in rs if r['reasoning_tokens'] is not None]
    print(f'{form}: {ok}/{len(rs)} 正确 | prompt≈{sum(pt)//max(len(pt),1)} | reasoning≈{sum(rt)//max(len(rt),1)}')
