# Version Registry

按 `platform/<product-line>.yaml` 保存人工核验后的版本到 commit 映射。

运行时只接受 `verified: true` 的记录。首次登记可以使用 `source: tag-scan`，确认线上构建与仓库 tag 对应后再改为核验状态；不要填写未经确认的 commit，也不要把 token 写入登记文件。

示例结构见 `docs/multi-platform-version-snapshot-design.md` §4.2。登记目录由 `HARMONY_AGENT_VERSION_REGISTRY_ROOT` 配置，默认是仓库根目录下的 `version-registry/`。

首条用户提示词明确包含版本时按指定版本绑定；未包含版本时，Runtime 在平台、产品线和形态能够唯一确定的范围内选择最新的 `verified: true` 构建。产品线可以由提示词或已确认的 LogCenter 事实补齐；如果平台/版本仍命中多个产品线或形态，必须补充信息，不跨端或跨产品线猜测。
