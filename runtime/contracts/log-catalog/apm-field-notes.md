# 培优客户端 APM 字段备忘（未来云）

供维护 Catalog / 拼 Lucene 时参考。四端 topic 前缀均为 `basiclog-monitor_26_*`，结构类似。

## 端与坐标

| service_id | topic | app_clientid | 形态 |
| --- | --- | --- | --- |
| 1116 | basiclog-monitor_26_1003041 | XesPadPyAndroid | Pad Android |
| 846 | basiclog-monitor_26_1002935 | XesPyAndroid | 手机 Android |
| 1028 | basiclog-monitor_26_1002996 | XesPyIOSHD | iPad HD iOS |
| 847 | basiclog-monitor_26_1002936 | XesPyIOS | iPhone iOS |

## 核心字段（`c`）

- `c.pp`：设备/App 画像（版本、机型、OS、渠道、业务线等）
- `c.monitorLogType`：
  - `1`：网络请求（`netWorkLogEntity`）
  - `2`：性能（`traceInfo`）
  - `5`：业务/自定义（`userLogInfo` / `jsBridgeInfo`）
  - `7`：Web 离线（`webOffline`，HD iOS 常见）

## 示例 Lucene

```text
c.monitorLogType:1
c.monitorLogType:5 AND c.pp:*banxue*
```

具体可索引字段以日志中心 `index=true` 配置为准；拼查询前可用 logcenterskill `fields --service <id>` 复核。

## 与 SLS 埋点的边界

Catalog 中 `prod-android` / `prod-ios` 为 **product_event**（阿里云埋点），不是本文件所述 APM。口语「安卓日志」未指明种类时应澄清。
