# minimax-proxy

在 opencode 里使用 **MiniMax Code（mcode）桌面端**已登录模型的一个**纯 Node、零第三方依赖**本地代理，并内置**每日随机时间自动签到**。

上游网关原生就是 **Anthropic Messages 协议**，所以本代理是**纯透传**（无格式转换），opencode 用 `@ai-sdk/anthropic` 直连即可：

- 国内版（cn）：`http://127.0.0.1:39305`
- 国际版（en）：`http://127.0.0.1:39306`

实测：非流式、SSE 流式、工具调用（`tool_use`）、签到状态与领取全部通过。

## ⚠️ 重要设计红线：只读，绝不刷新令牌

MiniMax 的 `refresh_token` 是**一次性轮换**的，且与桌面端共享。若代理主动调用 `/oauth2/token` 刷新，会消耗磁盘上的 refresh_token 而不写回，**桌面端随后检测到失效会把登录态清空（强制登出）**。

因此本代理：

- **只读** `accessToken`，绝不使用 `refreshToken`、绝不发起刷新、绝不写文件；
- access token（约 1 小时）由 **MiniMax Code 桌面端自行续期**，代理每次请求实时重读；
- token 过期/未登录时返回 401/503 提示「打开桌面端」，而不是自行刷新。

> 代价：桌面端必须保持登录/运行；关掉桌面端后 token 到期即失效（面板会显示 token 已过期）。

## 每日自动签到

- 每天早上 **07:00–10:00 之间随机一个时刻**自动领取（每区独立随机），时间点当天首次运行即固定并持久化到 `state/signin-state.json`，重启不重摇。
- 端点：`GET/POST {origin}/minimax-cloud/api/v1/signin/status|claim?timezone_id=<IANA>`（时区必须走 query 参数）。
- 三重防重：进程内当天门禁 + 领取前先查面板 + 服务端返回 `AlreadyClaimed` 幂等。
- 环境变量：`MINIMAX_SIGNIN=off` 关闭；`MINIMAX_SIGNIN_START_HOUR=7`、`MINIMAX_SIGNIN_END_HOUR=10` 调整窗口。
- 手动触发：`POST http://127.0.0.1:39305/signin/claim`（幂等）。

## 运行要求

- Node.js **22.19+ 或 24+**（TypeScript 由 Node 原生类型擦除直接运行，**无需构建、无需 npm install**）
- 本机已安装并登录 **MiniMax Code** 桌面端（代理只读其登录态，不修改、不上传）

登录态路径（`src/auth.ts`）：

| 区域 | 路径 |
| --- | --- |
| cn | `~/.minimax/auth/prod/cn/mcode-public/auth.json` |
| en | `~/.minimax/auth/prod/en/mcode-public/auth.json` |

## 安装

```powershell
git clone https://github.com/weixiaokuan123/minimax-proxy.git "$env:USERPROFILE\.config\opencode\minimax-proxy"
cd "$env:USERPROFILE\.config\opencode\minimax-proxy"

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1   # 启动
node .\scripts\inject-config.cjs                                          # 注入 provider
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1  # 查看状态
```

然后**重启 opencode**，选择 `MiniMax 国内版(代理)` 下的 `MiniMax-M3`。

macOS / Linux：`node src/serve.ts` 前台运行，`node scripts/inject-config.cjs` 注入。

## 日常运维（Windows）

| 操作 | 命令 |
| --- | --- |
| 启动 / 停止 / 状态 | `scripts\start.ps1`、`stop.ps1`、`status.ps1` |
| 开机自启 / 取消 | `scripts\install-autostart.ps1`、`uninstall-autostart.ps1` |
| 手动签到 | `POST http://127.0.0.1:39305/signin/claim` |

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MINIMAX_CN_PORT` / `MINIMAX_EN_PORT` | `39305` / `39306` | 端点端口 |
| `MINIMAX_SIGNIN` | `on` | 设为 `off` 关闭自动签到 |
| `MINIMAX_SIGNIN_START_HOUR` / `END_HOUR` | `7` / `10` | 随机窗口 |

## 安全模型

- 仅监听 `127.0.0.1`，四重回环校验（Host / Origin / `Content-Type` / bearer 常量时间比对，兼容 `x-api-key`）。
- `keys/*.key` 首次启动随机生成；`keys/`、`logs/`、`state/` 均在 `.gitignore` 排除，**仓库不含任何凭据**。
- 登录态只在本机读取，不写回、不落地、不外传至 MiniMax 官方网关之外的任何地址。

## 许可

MIT。上游协议参考自 MiniMax Code 桌面端（`@mavis/shared`）；本项目为独立实现的本地代理。详见 `LICENSE`。
