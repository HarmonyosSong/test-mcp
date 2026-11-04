# Mastra 外部开发知识

Mastra runtime 支持可选的只读外部开发知识 MCP。未配置时不会挂载外部工具。配置后每轮诊断会通过 `resolve_external_knowledge` 做产品覆盖和主题路由，再允许 `read_external_knowledge` 读取该轮已解析主题中推荐的 1–3 个章节。

适配层保留 Python runtime 的覆盖策略、用户原话要求、敏感信息拦截、主题冲突检查、MCP response schema 与来源引用闭包校验、最大返回体裁剪和脱敏错误分类。外部内容始终是静态知识线索，不是当前故障的观测证据；正向根因仍须引用本地代码或日志观察。

在 `.env` 设置：

```dotenv
HARMONY_AGENT_DEV_KNOWLEDGE_CONFIG=.data/dev-knowledge.json
```

HTTP transport 示例：

```json
{
  "transport": "http",
  "url": "https://knowledge.example.invalid/mcp/knowledge/v1",
  "token_env": "DEV_KNOWLEDGE_TOKEN",
  "products": [
    {
      "business_line": "cloudlearn",
      "product_id": "example-product",
      "terms": ["Example", "示例产品"],
      "topic_terms": {
        "known-topic-id": ["用户可识别的具体活动"]
      }
    }
  ],
  "excluded_terms": ["不应路由到该服务的产品"]
}
```

配置可使用 `stdio` 的 `command`、`args` 和 `cwd`，或使用 Streamable HTTP 的 `url`。远程 HTTP bearer token 只允许用于 HTTPS；本机 loopback endpoint 可使用 HTTP。URL 不得携带用户名、密码、query 或 fragment。认证值只从 `token_env` 指定的环境变量读取，不能写入配置文件。

配置校验失败、服务未连接或认证不可用时，工具会以明确失败结果告知 Agent；本地知识和代码/日志诊断仍可继续。外部 MCP client 按诊断轮次创建和关闭。配置路由必须明确列出业务线、产品和术语，不能通过模型参数猜测覆盖范围。

变更公共 MCP response schema 时，应将已审核的上游合同 bundle 更新到 `runtime/contracts/dev-knowledge/`，并运行 runtime 外部知识测试；测试会验证 bundle 中每个 schema/example 的 SHA-256 与随附 manifest 一致。上游合同仓库和固定 commit 记录在该目录的 `UPSTREAM.md`。
