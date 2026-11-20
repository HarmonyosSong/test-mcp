/**
 * 一次性补录：为指定会话重跑客户端侧分析，并把分析段补进已有的协查回执消息。
 * 用法：npx tsx test/manual-followup-backfill.ts <conversationId>
 */
import { loadRuntimeConfig } from '../src/config.js';
import { ModelConfiguration } from '../src/model/configuration.js';
import { CapabilityMcp } from '../src/capabilities/mcp.js';
import { ProductStore } from '../src/product/store.js';
import { createRuntimeDatabase } from '../src/migration/legacy.js';
import { analyzeFollowupWithSource } from '../src/diagnosis/followup-analysis.js';

const conversationId = process.argv[2];
if (!conversationId) throw new Error('usage: tsx test/manual-followup-backfill.ts <conversationId>');

const config = loadRuntimeConfig();
const store = new ProductStore(createRuntimeDatabase(config));
const conversation = await store.getConversation(conversationId);

const outcomeText = conversation.external_findings.at(-1)?.text;
if (!outcomeText) throw new Error('会话里没有已完成的协查结论');

const message = [...conversation.messages].reverse().find(
  (item) => item.role === 'assistant' && item.content.startsWith('【服务端协查结果】'),
);
if (!message) throw new Error('会话里没有协查回执消息');
if (message.content.includes('【客户端侧补充分析】')) {
  console.log('已含分析段，无需补录');
  process.exit(0);
}

const result = await analyzeFollowupWithSource({
  modelConfiguration: new ModelConfiguration({ filePath: config.modelConfigFile }),
  capabilities: new CapabilityMcp(config),
  conversation,
  outcome: {
    state: 'completed', text: outcomeText, taskId: null, contextId: null,
    truncated: false, limitations: [], durationMs: 0,
  },
});
if (!result) throw new Error('分析轮未产出');

message.content = message.content.replace(
  '以上为服务端协查（Compass）结论',
  `【客户端侧补充分析】\n${result.text}\n\n以上为服务端协查（Compass）结论`,
);
message.tool_usage = { ...message.tool_usage, followup_analysis: 1 };
conversation.updated_at = new Date().toISOString();
await store.saveConversation(conversation);
console.log('已补录，消息长度:', message.content.length);
process.exit(0);
