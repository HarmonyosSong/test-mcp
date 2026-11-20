/**
 * 手动验证：对指定会话最近一次已完成的协查结果，直接跑一次客户端侧源码分析轮。
 * 用法：npx tsx test/manual-followup-analysis.ts <conversationId>
 */
import { loadRuntimeConfig } from '../src/config.js';
import { ModelConfiguration } from '../src/model/configuration.js';
import { CapabilityMcp } from '../src/capabilities/mcp.js';
import { ProductStore } from '../src/product/store.js';
import { createRuntimeDatabase } from '../src/migration/legacy.js';
import { analyzeFollowupWithSource } from '../src/diagnosis/followup-analysis.js';

const conversationId = process.argv[2];
if (!conversationId) throw new Error('usage: tsx test/manual-followup-analysis.ts <conversationId>');

const config = loadRuntimeConfig();
const store = new ProductStore(createRuntimeDatabase(config));
const conversation = await store.getConversation(conversationId);
console.log('conversation:', conversation.id, '| workspace:', conversation.workspace_path);

const outcomeText = conversation.external_findings.at(-1)?.text;
if (!outcomeText) throw new Error('会话里没有已完成的协查结论（external_findings 为空）');
console.log('outcome 前 120 字:', outcomeText.slice(0, 120));

const result = await analyzeFollowupWithSource({
  modelConfiguration: new ModelConfiguration({ filePath: config.modelConfigFile }),
  capabilities: new CapabilityMcp(config),
  conversation,
  outcome: {
    state: 'completed',
    text: outcomeText,
    taskId: null,
    contextId: null,
    truncated: false,
    limitations: [],
    durationMs: 0,
  },
});

console.log('---- 分析结果 ----');
console.log(result ? result.text : '(null：跳过或失败)');
console.log('usage:', result?.inputTokens, '/', result?.outputTokens);
process.exit(0);
