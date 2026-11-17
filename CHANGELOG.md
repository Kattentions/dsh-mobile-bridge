# 变更记录

## 0.3.0

- 设备 token 化：桌面设置页可生成 6 位一次性配对码（2 分钟、一次有效），手机访问 `/pair?c=CODE` 换一枚 32 字节设备 token（HttpOnly cookie，服务端只存 SHA-256）；每个设备可单独撤销。
- 设置页「设备互联」新增配对码按钮与「已配对设备」列表（撤销即失效）；二维码优先用配对码 URL，主密钥深链保留作兼容。
- 新增 `/__ink/pair/code`、`/__ink/pair/devices`、`/__ink/pair/revoke` 三个本机接口。
- 主密钥 `?k=` 仍可用，但新配对不再把长期密钥写进二维码。
## 0.2.1

- 代理面收窄：WebSocket 只转发 GUI 实际使用的路径（/api/、/sidebar/、/__、/favicon、/assets/、manifest），其余升级请求返回 404 并计数。
- 认证限速：同一 IP 60 秒内 12 次错误密钥后返回 429 + Retry-After；成功配对后清空计数。
- 错误分级：上游不可达返回 502 `upstream-unreachable`、超时返回 504 `upstream-timeout`，不再是一段纯文本。
- `/__bridge` 诊断页不再对局域网匿名暴露密钥与计数（仅本机或已认证请求可读），新增 wsPaths / wsDenied / authFailures 计数。
- 密钥比较改用 `timingSafeEqual`。
