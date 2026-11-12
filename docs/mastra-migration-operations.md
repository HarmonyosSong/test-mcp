# Mastra 数据迁移运维

迁移工具读取旧 `.data/conversations.json`、`.data/repositories.json` 和快照元数据，把产品数据写入 runtime LibSQL。旧文件不会自动删除或覆盖。

## 预检查

确认 Node.js 版本和源文件路径：

```bash
node --version       # >=22.13.0
ls .data/conversations.json .data/repositories.json
```

不要把 `.data/model-config.json` 内容复制到报告、日志或提交中。模型配置由 runtime 继续从原路径读取，并保持 `0600` 权限。

## Dry-run 与 apply

```bash
npm --prefix runtime run migrate -- --mode dry-run
npm --prefix runtime run migrate -- --mode apply
```

dry-run 只读取源数据并输出报告。apply 会先创建带时间戳的备份，再写入目标 LibSQL；重复 apply 使用 source hash 返回 `no_op`。报告中的 `rejected` 记录格式不合法的旧记录，迁移不会用它们覆盖目标记录。

## 验证

```bash
make test-runtime
make build
HARMONY_MASTRA_SERVE_WEB=true npm --prefix runtime start
```

启动后检查 `GET /api/health`、`GET /api/conversations`，再打开网页确认会话和诊断报告可读；需要代码时再用用户提示词触发动态源码快照绑定。Runtime 启动诊断所需 MCP 时会调用 `uv`，因此演练环境也必须安装 Python/uv。迁移演练应优先使用 `/tmp` 中的数据副本和临时 LibSQL 文件。

## 回滚

```bash
npm --prefix runtime run migrate -- --mode rollback --migration-id <migration-id>
```

回滚只删除仍与迁移导入 hash 相同的目标行，并恢复迁移前存在且未被修改的行。若目标行已经变化，工具会保留它并在 `rollback_conflicts` 报告冲突；先人工处理冲突，再按报告决定是否恢复备份。
