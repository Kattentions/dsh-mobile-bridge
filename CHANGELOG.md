# 变更记录

## 0.2.1

- 代理面收窄：WebSocket 只转发 GUI 实际使用的路径（/api/、/sidebar/、/__、/favicon、/assets/、manifest），其余升级请求返回 404 并计数。
- 认证限速：同一 IP 60 秒内 12 次错误密钥后返回 429 + Retry-After；成功配对后清空计数。
- 错误分级：上游不可达返回 502 `upstream-unreachable`、超时返回 504 `upstream-timeout`，不再是一段纯文本。
- `/__bridge` 诊断页不再对局域网匿名暴露密钥与计数（仅本机或已认证请求可读），新增 wsPaths / wsDenied / authFailures 计数。
- 密钥比较改用 `timingSafeEqual`。
