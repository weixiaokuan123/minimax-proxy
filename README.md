# minimax-proxy

在 opencode 里使用 **MiniMax Code（mcode）桌面端**已登录模型的一个**纯 Node、零第三方依赖**本地代理，并内置**每日随机时间自动签到**。

上游网关原生就是 **Anthropic Messages 协议**，所以本代理是**纯透传**（无格式转换），opencode 用 `@ai-sdk/anthropic` 直连即可：

- 国内版（cn）：`http://127.0.0.1:39305`
- 国际版（en）：`http://127.0.0.1:39306`

实测：非流式、SSE 流式、工具调用（`tool_use`）、签到状态与领取全部通过。

## 导览

> 这一节写给「懂技术、但没接触过这套东西」的人。读完这一节就能明白本项目在干什么、
> 以及你最关心的那个功能（token 过期会自动帮你打开桌面端）在哪。
> 下面原有的技术文档一字未改。

### 为什么需要它

MiniMax Code 桌面端只给你一个图形界面，**没有给命令行工具用的接口**；而且它的登录凭据是加密存在本地的。
而 opencode 需要一个 HTTP API 才能调用模型。

本项目做中间那一层：**读取桌面端的登录态 → 包装成标准 Anthropic Messages 接口 → 交给 opencode 用。**
顺带把每天的签到积分领了。

一句话：**让你已经付费登录的 MiniMax Code 账号，能在 opencode 里当 API 用。**

它和另外两个平台代理（`workbuddy-proxy`、`trae-proxy`）是并列关系，各自独立、互不依赖。
三者的状态汇总在一个网页面板里（`agent-hub`）。

### 你最该知道的一件事

**token 过期时，它会自己把 MiniMax Code 桌面端打开，等它续期，然后继续完成你这次的请求。**

你不会收到 401，只会觉得「这一次稍微慢了一点」。这是本项目相对同类方案最省心的地方——
不用你记得去开桌面端、也不用你手动重试。

（下文「token 过期自动续期」一节讲这件事的实现细节。）

### 端口

| 区域 | 地址 |
| --- | --- |
| 国内版（cn） | `http://127.0.0.1:39305` |
| 国际版（en） | `http://127.0.0.1:39306` |

### 术语速查

| 词 | 意思 |
| --- | --- |
| **回环 / loopback** | 只监听 `127.0.0.1`，只有本机能访问 |
| **bearer key** | 首次启动随机生成的调用钥匙，防止本机其它程序误用你的账号 |
| **透传** | 不改内容，原样转发。本项目上游本来就是 Anthropic 协议，所以无需转换 |
| **幂等** | 同一操作做多次和做一次结果相同。签到已领就跳过 |
| **只读凭据** | 本项目**只读**桌面端的登录文件，绝不写回。原因是 MiniMax 的 refresh token 是一次性轮换的，见下文红线 |
| **ownership 标记** | 记录「这个桌面端是代理拉起的」，以便只关自己拉起的那个，不误关你手动打开的 |

### 最短上手路径

```powershell
git clone https://github.com/weixiaokuan123/minimax-proxy.git "$env:USERPROFILE\.config\opencode\minimax-proxy"
cd "$env:USERPROFILE\.config\opencode\minimax-proxy"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1   # 启动
node .\scripts\inject-config.cjs                                          # 注入 provider
```

然后**重启 opencode**，在模型列表里选 `MiniMax 国内版(代理)` 下的 `MiniMax-M3`。
前提是本机已安装并登录 MiniMax Code 桌面端。

---

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

### 拉起后自动最小化，不挡桌面

桌面端自己写死了「启动即 `show()` + `focus()`」（`createArchonChatWindow` 里
`window.once('ready-to-show', () => { window.show(); window.focus() })`），
代理改不了它启动时的形态，只能在它起来后把窗口收到任务栏：

- **只对代理拉起的实例**收起窗口；你手动打开的实例不动（方便正常用界面）
- 与等 token 写盘**并行**执行，不拖慢续期
- 日志会打印 `桌面端窗口已最小化到任务栏`

- 关闭：`MINIMAX_MINIMIZE_ON_LAUNCH=off`
- 等待窗口出现的上限：`MINIMAX_MINIMIZE_WAIT_MS=30000`

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
| `MINIMAX_AUTO_LAUNCH` | `on` | 设为 `off` 关闭「token 过期自动拉起桌面端」 |
| `MINIMAX_MINIMIZE_ON_LAUNCH` | `on` | 设为 `off` 则拉起后不收窗口 |
| `MINIMAX_MINIMIZE_WAIT_MS` | `30000` | 等待窗口出现并最小化的上限 |
| `MINIMAX_IDLE_EXIT_MS` | `1200000` | 空闲多久退出代理拉起的桌面端；`0` 关闭 |
| `MINIMAX_IDLE_TICK_MS` | `30000` | 空闲检查间隔 |
| `MINIMAX_LAUNCH_WAIT_MS` | `120000` | 等待桌面端续期的上限 |
| `MINIMAX_QUIT_WAIT_MS` | `30000` | 等待桌面端退出的上限 |

## 安全模型

- 仅监听 `127.0.0.1`，四重回环校验（Host / Origin / `Content-Type` / bearer 常量时间比对，兼容 `x-api-key`）。
- `keys/*.key` 首次启动随机生成；`keys/`、`logs/`、`state/` 均在 `.gitignore` 排除，**仓库不含任何凭据**。
- 登录态只在本机读取，不写回、不落地、不外传至 MiniMax 官方网关之外的任何地址。

## 许可

MIT。上游协议参考自 MiniMax Code 桌面端（`@mavis/shared`）；本项目为独立实现的本地代理。详见 `LICENSE`。
