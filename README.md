# minimax-proxy

在 opencode 里使用 **MiniMax Code（mcode）桌面端**已登录模型的一个**纯 Node、零第三方依赖**本地代理，并内置**每日随机时间自动签到**。

上游网关原生就是 **Anthropic Messages 协议**，所以本代理是**纯透传**（无格式转换），opencode 用 `@ai-sdk/anthropic` 直连即可：

- 国内版（cn）：`http://127.0.0.1:39305`
- 国际版（en）：`http://127.0.0.1:39306`

实测：非流式、SSE 流式、工具调用（`tool_use`）、签到状态与领取全部通过。

## ⚠️ 重要设计红线：只读，绝不刷新令牌

MiniMax 的 `refresh_token` 是**一次性轮换**的，且与桌面端共享。若代理主动调用 `/oauth2/token` 刷新，会消耗磁盘上的 refresh_token 而不写回，**桌面端随后检测到失效会把登录态清空（强制登出）**。

因此本代理：

- **只读** `accessToken`，绝不使用 `refreshToken`、绝不发起刷新、绝不写 auth 文件；
- access token（约 1 小时）由 **MiniMax Code 桌面端自行续期**，代理每次请求实时重读。

> 一手的协议分析（端点、`client_id` 公开常量、轮换机制、桌面端那套跨进程锁）见
> [`docs/minimax-token-research.md`](docs/minimax-token-research.md)。

## token 过期自动续期（无需手动开桌面端）

既然续期只能由桌面端做，代理就在**需要时把它叫起来**——你不需要再手动开：

1. 请求进来 → 发现 token 已过期（`expired`）
2. 代理**自动拉起 MiniMax Code 桌面端**（进程已在运行则直接复用）
3. 轮询等待它写回新 token（实测约 10~25 秒）
4. 用新 token 继续完成**本次请求**（你不会收到 401）

页面/客户端只会感觉**这一次请求慢了一点**，之后恢复正常。

- 关闭：`MINIMAX_AUTO_LAUNCH=off`（关闭后退化为「过期即报错」）
- 等待上限：`MINIMAX_LAUNCH_WAIT_MS=120000`

> 只对「有凭据但已过期」（`expired`）生效。若该区域**从未登录**（`signed-out`），
> 拉起桌面端也救不回来（桌面端只续当前登录区），此时如实报错，不会反复弹窗。

## 空闲自动退出

代理拉起的桌面端，**闲置 20 分钟后自动关闭**，避免它一直挂在后台。

| 规则 | 说明 |
| --- | --- |
| **只关自己拉起的** | 你手动打开的桌面端**永不触碰**（ownership 标记） |
| **以代理请求计时** | 只要还有请求进来就不断续命，长时间使用不会被打断 |
| **重启不失忆** | ownership 落盘到 `state/desktop-ownership.json`，代理重启/开机自启后仍会接管 |
| **退出前二次确认** | 判定与真正杀进程之间若刚好来了请求，会取消退出 |

- 调整空闲时长：`MINIMAX_IDLE_EXIT_MS=1200000`（毫秒；`0` 表示关闭自动退出）
- 检查间隔：`MINIMAX_IDLE_TICK_MS=30000`

## 每日自动签到

- 每天早上 **07:00–10:00 之间随机一个时刻**自动领取（每区独立随机），时间点当天首次运行即固定并持久化到 `state/signin-state.json`，重启不重摇。
- 端点：`GET/POST {origin}/minimax-cloud/api/v1/signin/status|claim?timezone_id=<IANA>`（时区必须走 query 参数）。
- 三重防重：进程内当天门禁 + 领取前先查面板 + 服务端返回 `AlreadyClaimed` 幂等。
- 环境变量：`MINIMAX_SIGNIN=off` 关闭；`MINIMAX_SIGNIN_START_HOUR=7`、`MINIMAX_SIGNIN_END_HOUR=10` 调整窗口。
- 手动触发：`POST http://127.0.0.1:39305/signin/claim`（幂等）。

## 运行要求

- Node.js **22.19+ 或 24+**（TypeScript 由 Node 原生类型擦除直接运行，**无需构建、无需 npm install**）
- 本机已安装并登录 **MiniMax Code** 桌面端（代理只读其登录态，不修改、不上传）

运行测试（不联网、不触碰真实进程）：

```powershell
node --test test/session.test.ts
```

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
