import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClient } from "@libsql/client";

import { loadRuntimeConfig } from "../src/config.js";
import { createRuntimeDatabase } from "../src/migration/legacy.js";
import { ProductNotFoundError, ProductStore } from "../src/product/store.js";
import { createConversationRoutes } from "../src/http/conversations.js";
import type {
  DiagnosisAgent,
  DiagnosisRunInput,
} from "../src/diagnosis/agent.js";
import type { CapabilityMcp } from "../src/capabilities/mcp.js";
import type { ModelConfiguration } from "../src/model/configuration.js";

test("product store owns conversation CRUD and repairs stale streaming messages", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "troubleshoot-product-store-"));
  const config = loadRuntimeConfig({
    HARMONY_MASTRA_DATA_DIR: dataDir,
    HARMONY_MASTRA_DATABASE_URL: `file:${join(dataDir, "runtime.db")}`,
  });
  const client = createRuntimeDatabase(config);
  const store = new ProductStore(client);
  await store.createConversation({
    id: "conv-store",
    title: "store test",
    messages: [
      {
        id: "user-1",
        role: "user",
        content: "白屏",
        status: "completed",
        steps: [],
        error: null,
        report: null,
        input_tokens: null,
        output_tokens: null,
        tool_usage: {},
        created_at: "2026-11-03T00:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "半截",
        status: "streaming",
        steps: [
          {
            id: "tool-1",
            tool: "read_project_file",
            status: "running",
            summary: "读取中",
            arguments_summary: null,
            result_summary: null,
            duration_ms: null,
            created_at: "2026-11-03T00:00:01.000Z",
          },
        ],
        error: null,
        report: null,
        input_tokens: null,
        output_tokens: null,
        tool_usage: {},
        created_at: "2026-11-03T00:00:01.000Z",
      },
    ],
  });
  await client.close();

  const restarted = new ProductStore(createClient({ url: config.databaseUrl }));
  const recovered = await restarted.getConversation("conv-store");
  assert.equal(recovered.messages[1]?.status, "failed");
  assert.equal(recovered.messages[1]?.content, "");
  assert.equal(recovered.messages[1]?.report, null);
  assert.equal(recovered.messages[1]?.error, "回复中断：服务重启前未完成");
  assert.equal(recovered.messages[1]?.steps[0]?.status, "failed");
  assert.equal(recovered.messages[0]?.content, "白屏");

  let followupInput: DiagnosisRunInput | undefined;
  const routes = createConversationRoutes(
    restarted,
    {
      async *stream(input: DiagnosisRunInput) {
        followupInput = input;
        yield {
          type: "completed",
          text: "请补充启动日志。",
          report: null,
          evidence_state: input.conversation.evidence_state as Record<
            string,
            unknown
          >,
          messages_state: [],
          input_tokens: null,
          output_tokens: null,
          tool_usage: {},
        };
      },
    } as unknown as DiagnosisAgent,
    { createKnowledgeSession: async () => null } as unknown as CapabilityMcp,
    { enabled: true } as ModelConfiguration,
    {
      knowledgeQueryLog: join(dataDir, "queries.jsonl"),
      caseArchiveDir: join(dataDir, "cases"),
    },
  );
  const response = await routes.request("/conversations/conv-store/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "我可以补充启动日志" }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(followupInput?.conversation.messages[0]?.content, "白屏");
  assert.equal(followupInput?.conversation.messages[1]?.content, "");
  assert.equal(followupInput?.conversation.messages[1]?.status, "failed");
  assert.equal(followupInput?.content, "我可以补充启动日志");
  const followed = await restarted.getConversation("conv-store");
  assert.equal(followed.messages.at(-1)?.status, "completed");

  assert.deepEqual((await restarted.listConversations())[0], {
    id: "conv-store",
    title: "store test",
    repository_name: null,
    message_count: followed.messages.length,
    updated_at: followed.updated_at,
  });
  await assert.rejects(
    () => restarted.getConversation("missing"),
    ProductNotFoundError,
  );
  await restarted.deleteConversation("conv-store");
  await restarted.close();
  await rm(dataDir, { recursive: true, force: true });
});
