import { createHash } from "node:crypto";

import type { Client } from "@libsql/client";

import { ensureProductSchema } from "../migration/legacy.js";
import {
  ChatMessageSchema,
  ConversationRecordSchema,
  RepositoryRecordSchema,
  RepositorySnapshotSchema,
  type ChatMessage,
  type ConversationRecord,
  type RepositoryRecord,
  type RepositorySnapshot,
} from "../domain/schemas.js";

type ProductEntity = "conversation" | "repository" | "snapshot";

const tableByEntity: Record<ProductEntity, string> = {
  conversation: "product_conversations",
  repository: "product_repositories",
  snapshot: "product_snapshots",
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toData(value: unknown): string {
  return JSON.stringify(value);
}

function parseData<T>(value: unknown): T {
  if (typeof value !== "string")
    throw new Error("product record data is not text");
  return JSON.parse(value) as T;
}

export class ProductNotFoundError extends Error {}

export class ProductConflictError extends Error {}

export interface ConversationSummary {
  id: string;
  title: string;
  channel: 'web' | 'yach_im';
  repository_name: string | null;
  message_count: number;
  updated_at: string;
}

export class ProductStore {
  private ready: Promise<void> | undefined;

  constructor(private readonly client: Client) {}

  async initialize(): Promise<void> {
    this.ready ??= (async () => {
      await ensureProductSchema(this.client);
      await this.repairInterruptedConversations();
    })();
    await this.ready;
  }

  async listConversations(): Promise<ConversationSummary[]> {
    await this.initialize();
    const result = await this.client.execute(
      "SELECT data FROM product_conversations ORDER BY updated_at DESC",
    );
    return result.rows.map((row) => {
      const conversation = ConversationRecordSchema.parse(
        parseData<unknown>(row.data),
      );
      return {
        id: conversation.id,
        title: conversation.title,
        channel: conversation.channel ?? 'web',
        repository_name: conversation.repository_name,
        message_count: conversation.messages.length,
        updated_at: conversation.updated_at,
      };
    });
  }

  async getConversation(id: string): Promise<ConversationRecord> {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT data FROM product_conversations WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    if (!row) throw new ProductNotFoundError(`conversation not found: ${id}`);
    return ConversationRecordSchema.parse(parseData<unknown>(row.data));
  }

  async saveConversation(
    conversation: ConversationRecord,
  ): Promise<ConversationRecord> {
    await this.initialize();
    return this.saveConversationReady(conversation);
  }

  private async saveConversationReady(
    conversation: ConversationRecord,
  ): Promise<ConversationRecord> {
    const parsed = ConversationRecordSchema.parse(conversation);
    const data = toData(parsed);
    await this.client.execute({
      sql: `INSERT INTO product_conversations (id, data, record_hash, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data,
              record_hash = excluded.record_hash, updated_at = excluded.updated_at`,
      args: [parsed.id, data, digest(data), parsed.updated_at],
    });
    return parsed;
  }

  async createConversation(
    input: Partial<ConversationRecord> = {},
  ): Promise<ConversationRecord> {
    const conversation = ConversationRecordSchema.parse({
      ...input,
      messages: input.messages ?? [],
      messages_state: input.messages_state ?? [],
      evidence_state: input.evidence_state ?? {},
    });
    return this.saveConversation(conversation);
  }

  async deleteConversation(id: string): Promise<void> {
    await this.initialize();
    const result = await this.client.execute({
      sql: "DELETE FROM product_conversations WHERE id = ?",
      args: [id],
    });
    if (result.rowsAffected !== 1)
      throw new ProductNotFoundError(`conversation not found: ${id}`);
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    await this.initialize();
    const result = await this.client.execute(
      "SELECT data FROM product_repositories ORDER BY data",
    );
    return result.rows.map((row) =>
      RepositoryRecordSchema.parse(parseData<unknown>(row.data)),
    );
  }

  async getRepository(id: string): Promise<RepositoryRecord> {
    const records = await this.listRepositories();
    const record = records.find((item) => item.id === id);
    if (!record) throw new ProductNotFoundError(`repository not found: ${id}`);
    return record;
  }

  async saveRepository(
    repository: RepositoryRecord,
  ): Promise<RepositoryRecord> {
    await this.initialize();
    const parsed = RepositoryRecordSchema.parse(repository);
    const data = toData(parsed);
    await this.client.execute({
      sql: `INSERT INTO product_repositories (id, data, record_hash, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data,
              record_hash = excluded.record_hash, updated_at = excluded.updated_at`,
      args: [parsed.id, data, digest(data), parsed.updated_at],
    });
    return parsed;
  }

  async saveSnapshot(
    snapshot: RepositorySnapshot,
  ): Promise<RepositorySnapshot> {
    await this.initialize();
    const parsed = RepositorySnapshotSchema.parse(snapshot);
    const data = toData(parsed);
    const id = `${parsed.repository_id}:${parsed.resolved_commit}`;
    await this.client.execute({
      sql: `INSERT INTO product_snapshots (id, data, record_hash, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data,
              record_hash = excluded.record_hash, created_at = excluded.created_at`,
      args: [id, data, digest(data), parsed.created_at],
    });
    return parsed;
  }

  async getSnapshot(
    repositoryId: string,
    commit: string,
  ): Promise<RepositorySnapshot> {
    await this.initialize();
    const result = await this.client.execute({
      sql: "SELECT data FROM product_snapshots WHERE id = ?",
      args: [`${repositoryId}:${commit}`],
    });
    const row = result.rows[0];
    if (!row)
      throw new ProductNotFoundError(
        `snapshot not found: ${repositoryId}:${commit}`,
      );
    return RepositorySnapshotSchema.parse(parseData<unknown>(row.data));
  }

  private async repairInterruptedConversations(): Promise<void> {
    const result = await this.client.execute(
      "SELECT data FROM product_conversations",
    );
    for (const row of result.rows) {
      const conversation = ConversationRecordSchema.parse(
        parseData<unknown>(row.data),
      );
      const hasStreaming = conversation.messages.some(
        (message) => message.status === "streaming",
      );
      if (!hasStreaming) continue;
      const messages = conversation.messages.map((message) => {
        if (message.status !== "streaming") return message;
        return ChatMessageSchema.parse({
          ...message,
          status: "failed",
          error: "回复中断：服务重启前未完成",
          content: "",
          steps: message.steps.map((step) =>
            step.status === "running"
              ? {
                  ...step,
                  status: "failed",
                  summary: "服务重启前工具调用中断，结果未知",
                }
              : step,
          ),
          report: null,
        });
      });
      await this.saveConversationReady({ ...conversation, messages });
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function messageWithStatus(
  message: ChatMessage,
  status: ChatMessage["status"],
  patch: Partial<ChatMessage> = {},
): ChatMessage {
  return ChatMessageSchema.parse({ ...message, ...patch, status });
}

export { tableByEntity };
