# dsh-mobile-bridge

DeepSeek Harness 手机桥：让同一局域网（或蒲公英/Tailscale 这类虚拟局域网）里的手机访问电脑上的 DSH 界面，顺带托管配对页、APK 下载和「这一轮结束了」通知流。

从 `aurora-boot` 主题插件里拆出来的独立插件，只做桥，不带皮肤。

## 它做什么

桌面版的 DSH GUI 只监听 `127.0.0.1`，而且每个文档请求都带一次性 launch token，别的设备根本打不开。这个插件在局域网另开一个端口（默认 6080，被占用就依次试 6081/6090/7090）：

- 把请求代理回 `127.0.0.1` 的 GUI，Cookie 留在电脑侧
- 用一次性 `?k=<key>` 换长期 Cookie，之后手机不用带 token
- 提供 `dshharness://pair?u=<url>` 二维码配对页
- 给手机用的目录选择接口（桌面弹窗在 WebView 里打不开）
- APK 下载页和版本清单，手机 App 可据此检查更新
- 完成事件通知流，手机壳轮询后弹系统通知

## 设置里的「设备互联」

装好后 DSH 设置里会多一页**设备互联**（左下角账号菜单 → 设置，或 `Ctrl+,`）：

- 桥的运行状态和端口
- 配对二维码，手机 App 直接扫
- 每个网络接口的连接地址，一键复制带密钥的链接
- 手机 App 下载入口和当前版本
- 最近连接过的设备：IP、设备类型、最后活动时间

![设备互联](docs/device-connections.png)

设备列表只记录通过桥访问过的客户端，用来确认「到底是谁在用」；真正撤销某台设备目前还是整把换 key（删掉 key 文件重启 DSH）。

## 最省事的安装

装完就能用：不用加启动参数，不用改配置。

1. DSH 里打开 **插件 → 发现 → 索引源**，加上这个地址：

   ```
   https://cdn.jsdelivr.net/gh/Kattentions/dsh-katt-browser@main/index.json
   ```

   这个源里包含手机桥（和侧栏浏览器），点「安装」即可。
2. 装完重启 DSH。
3. 直接让 agent 打开网页即可；右侧栏没开、甚至没打开过浏览器标签页，第一次操作会自动展开。

命令行等价（不需要 git）：

```sh
dsh plugin --profile desktop add https://cdn.jsdelivr.net/gh/Kattentions/dsh-katt-browser@main/dist/dsh-mobile-bridge-latest.tgz
```

## 安装

```sh
# npm（发布后）
dsh plugin --profile desktop add dsh-mobile-bridge

# Release 压缩包，不需要 git
dsh plugin --profile desktop add https://github.com/Kattentions/dsh-mobile-bridge/releases/download/v0.2.0/dsh-mobile-bridge-0.2.0.tgz
```

装完重启 DSH，然后打开配对页：

```
http://127.0.0.1:<GUI端口>/__ink/pair
```

Windows 上可以用仓库里的 `open-pair.cmd`（从 `~/.dsh/mobile-bridge.json` 读 GUI 地址）。

## 配对与安全

- 桥只对局域网/虚拟局域网开放，**不要把这个端口映射到公网**
- key 存在 `~/.dsh/mobile-bridge.key`，重启复用，换 key 等于让所有已配对设备失效
- Cookie 是长期有效的；换网络或怀疑泄露时，删掉 key 文件再重启 DSH 即可全部作废
- 状态文件 `~/.dsh/mobile-bridge.json` 记录当前端口、地址和 key，供配对页和手机 App 读取

## 接口

| 路径 | 用途 |
|---|---|
| `/__ink/ping` | 存活探测，返回 `pong` |
| `/__ink/pair` | 配对页（二维码） |
| `/__ink/pair/state` | 配对信息 JSON |
| `/__ink/pair/qr?d=<text>` | 二维码 SVG |
| `/__ink/fs?path=` | 手机端目录选择列表 |
| `/__ink/app` | APK 下载页 |
| `/__ink/app/version.json` | 版本清单 |
| `/__ink/app/dsh-harness.apk` | 安装包 |
| `/__ink/notify`、`/last`、`/state`、`/test` | 完成事件流与诊断 |

## 和手机壳的关系

配套 Android 壳（`dsh-harness`，源码在 DSH 工作区的 `_android`）就是本仓库 `public/app` 里那份 APK 的源码产物：扫码配对、WebView 全屏、文件上传下载、后台完成通知、更新检查。

## 已知边界

- 只代理，不做隧道；公网访问请用 Cloudflare Quick Tunnel / Tailscale / 蒲公英，并自行评估风险
- 一把 key 对应所有设备，暂不支持按设备单独撤销
- APK 下载路由读的是插件目录下的 `public/app`，没有文件时返回 404
