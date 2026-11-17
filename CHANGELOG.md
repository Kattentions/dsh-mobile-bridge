# 变更记录

## 0.4.7

- 新增 `scripts/check-endpoints.mjs`（`npm run check`）：静态对比手机壳源码引用的 `/__ink/...` 路径和宿主注册的路由。手机壳和宿主是分开演进的，路由改名以前只有真机上才会发现。当前结果：宿主 19 条路由，手机壳引用 5 条，全部有对应。
- README 补「开发自检」小节。
## 0.4.6

- 新增 `POST /__ink/phone/clear`：清空手机命令队列与所有设备游标。测试通知或误发的广播会一直等下一台手机轮询，之前没有清理入口；现在配对管理/排查时可以一键清掉。
- 发布前用该接口清掉了本轮多设备测试留下的队列，设备列表里的测试设备也已撤销（当前设备数 0）。
## 0.4.5

多设备同时连接时，通知只会被一台手机收到——这是真 bug：

- `/__ink/phone/pull` 以前用 `splice` 取走命令，谁先轮询谁拿走，另一台永远收不到。现在命令广播，每台设备各有一条读取游标（`PHONE_CURSORS`），只推进自己的进度，不消费队列。
- 代理在转发前会把客户端 Cookie 换成上游 GUI 会话，路由里根本拿不到设备 token，所以游标最初只能按「共享」算，一台推进后另一台也变成空。现在代理解析设备后通过内部头 `x-dsh-bridge-device` 把设备 id 传给路由（客户端自带的同名头会被剥掉，伪造不了）。
- `phone_state` 增加 `cursors` 数量。
- 实测：两台新配对的设备各自都收到同一条通知，第二次轮询都为空；伪造设备头返回 401。
## 0.4.4

- 文档（不改行为）：README 中英双语新增「通知」一节——根会话才推、负载带会话标题与工作区、手机 3.1 正文显示「工作区文件夹 · 会话标题」、桌面 toast 在窗口聚焦时不弹；接口表补 `/__ink/notify/focus`。
## 0.4.3

- Windows 通知不再在你正用着 DSH 的时候弹：GUI 通过 `/__ink/notify/focus` 上报窗口焦点，`uiFocused` 为真时只推手机事件、不弹桌面 toast。手机通知照旧，不受影响。
- `/__ink/notify/state` 增加 `uiFocused` 字段。
## 0.4.2

- 诊断日志不再无限增长：`notify-hello.log` 超过 128 KiB、`ui-dump.txt` 超过 256 KiB 自动轮转为 `.old`（之前的 hello 日志已经 177 KB）。
- 手机壳 3.1（versionCode 22）：通知正文带上工作区文件夹名 + 会话标题，多工作区同时跑的时候能看出是哪一条。
## 0.4.1

- 修通知 hub 崩溃点：`shared.streams` 的 add/delete/clear 写错成 `streamsadd/streamsdelete/streamsclear`，客户端断流时会抛 TypeError；`/__ink/notify/state` 里引用了不存在的 `titles`/`polls`，访问即 500。
- 根会话判定改用 session header 的 `parentSession`：子会话/团队成员的 turn-end 不再推到手机。
- 通知负载补 `cwd`（工作区路径）和会话标题：手机上收到「这一轮结束了」能知道是哪个会话/工作区，后续 App 可以直接展示。

## 0.4.0

- 手机能力反向暴露：新增 agent 工具 `phone_notify` / `phone_state`，命令经 `/__ink/phone/pull|result` 排队，App 的后台轮询取走并执行，执行完回执。
- 配对二维码改发 `dshharness://pair` 深链（内含 `/pair?c=` 一次性码，两条网络互为 fallback），App 扫码后直接进配对流程。
- 手机壳 3.0（versionCode 21）：后台服务同时轮询手机命令；配对成功后把已消费的 `?c=` 地址换成干净 origin，避免下次启动拿旧码反复 401。
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
