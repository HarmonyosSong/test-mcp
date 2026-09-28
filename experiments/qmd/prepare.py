"""Freeze a small pilot dataset and capture the current lookup_issue baseline."""
import asyncio
import hashlib
import json
from pathlib import Path
from time import perf_counter

from fastmcp import Client
from harmony_knowledge_mcp.server import create_knowledge_server

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.data/qmd-pilot'
EXTRA = [
    ('错题本进不去', ['error-book-unavailable', 'error-book-entry-picai-only']),
    ('想把做错的题汇总起来复习，功能从哪儿进', ['error-book-unavailable', 'error-book-entry-picai-only']),
    ('孩子做错的那些题，能不能集中找出来再练一遍', ['error-book-unavailable', 'error-book-entry-picai-only']),
    ('组合加购', ['combo-addon-unavailable', 'combo-addon-promotion']),
    ('买正价班时顺带优惠买的那门课，怎么不让抵扣优惠券', ['combo-addon-unavailable', 'combo-addon-promotion']),
    ('买大课搭售的小课，退款的时候必须一起退吗', ['combo-addon-unavailable', 'combo-addon-promotion']),
    ('付钱之前那份需要家长签字的文件没有弹出来', ['cannot-sign-contract', 'order-contract-agreement-sources']),
    ('孩子没做题就能展开标准解法，家长能把这个关了吗', ['handout-answer-not-shown', 'handout-answer-visibility-permission']),
    ('课上老师写的那些板书，课后能存成文件吗', ['learning-material-replay-missing', 'class-notes-in-materials']),
    ('已经下课了，想重新看老师讲的内容，在哪打开', ['learning-material-replay-missing', 'class-replay-and-cloud-listening']),
]


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cases = []
    for i, line in enumerate((ROOT / 'agent/evals/datasets/knowledge_retrieval.jsonl').read_text().splitlines()):
        item = json.loads(line)
        cases.append({'id': f'existing-{i}', 'query': item['query'], 'split': item['split'],
                      'expected': [item['expected']] if item['expected'] else []})
    for i, (query, expected) in enumerate(EXTRA):
        cases.append({'id': f'pilot-{i}', 'query': query, 'split': 'pilot_rewrite', 'expected': expected})
    inventory = {str(p.relative_to(ROOT / 'knowledge')): hashlib.sha256(p.read_bytes()).hexdigest()
                 for pattern in ('facts/*/*.md', 'symptoms/*.md')
                 for p in sorted((ROOT / 'knowledge').glob(pattern))}
    result = {'cases': cases, 'corpus': inventory, 'baseline': []}
    async with Client(create_knowledge_server(ROOT / 'knowledge', query_log_path='off')) as client:
        for item in cases:
            start = perf_counter()
            response = await client.call_tool('lookup_issue', {'query': item['query']})
            result['baseline'].append({'id': item['id'], 'mode': 'baseline',
                'elapsed_ms': round((perf_counter()-start)*1000, 2),
                'hits': [{'name': h['name'], 'score': h['score']}
                         for h in response.structured_content['hits']]})
    (OUT / 'fixtures.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f'{len(cases)} queries, {len(inventory)} entries; baseline saved')


if __name__ == '__main__':
    asyncio.run(main())
