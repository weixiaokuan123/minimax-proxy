# MiniMax 是否必须开着桌面端 —— 研究报告

> 结论日期：2026-09-23
> 方法：静态分析本机 `MiniMax Code` 桌面端打包代码（`D:\Software\MiniMaxCode\MiniMax Code\resources\app.asar`，531 MB），
> 定位其 OAuth 实现；未做任何修改、未发任何请求、未读取或写入任何 token。

## 一、结论速览

| 问题 | 答案 |
|---|---|
| token 必须靠桌面端续期吗？ | **不必须。** 续期走的是标准 OAuth2 `refresh_token` 授权，任何持有 refresh_token 的程序都能刷 |
| 代理能自己刷吗？ | **技术上能，且不难**（一个 `POST`，见下） |
| 那为什么当初定"绝不自己刷"的红线？ | 因为**并发刷新会互相作废**——这是真实存在的竞态，不是疑神疑鬼 |
| 有没有安全的自主刷新办法？ | **有。** 需要实现"跨进程锁 + generation 单调递增 + 落盘原子写"，即复刻桌面端的 `oauth-core` 协议 |

## 二、桌面端的真实 OAuth 实现

从 `app.asar` 提取到的关键文件（位于 `node_modules/@mavis/oauth-core/dist/`）：

### 端点（`endpoint-config.js`）

```
CN:  https://account.minimax.cn/oauth2/token
EN:  https://account.minimax.io/oauth2/token
```

标准 HTTPS、标准路径，**没有自定义签名、没有设备指纹绑定、没有 mTLS**。

### 客户端常量（`contracts.js`）

```js
export const MCODE_OAUTH_CLIENT_ID = 'mcode-public';
export const MCODE_OAUTH_SCOPES    = ['agent.default'];
export const MCODE_OAUTH_AUDIENCE  = 'agent-backend';
```

全部是**公开常量，硬编码在客户端里**，不是每个用户不同的密钥。

### 刷新请求（`oauth-client.js:115-124`）

```js
async refreshToken(refreshToken) {
    const body = await this.postForm(this.options.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: MCODE_OAUTH_CLIENT_ID,       // 'mcode-public'
        scope: MCODE_OAUTH_SCOPES.join(' '),    // 'agent.default'
        audience: MCODE_OAUTH_AUDIENCE,         // 'agent-backend'
    });
    return parseTokenGrant(body, refreshToken);
}
```

`application/x-www-form-urlencoded` 表单 POST。**就是普通的 OAuth2 刷新，没有任何私有加密。**

### refresh_token 是否轮换？（`oauth-client.js:186`）

```js
const refreshToken = readString(body, 'refresh_token') ?? previousRefreshToken;
```

**关键**：服务端**可能返回新的 refresh_token（轮换），也可能不返回（复用旧的）**。
代码用 `??` 兜底：返回了就用新的，没返回就沿用旧的。

→ 这解释了磁盘上 `generation: 81` 的含义：**已经轮换过 81 次**。

## 三、为什么会有"绝不能自己刷"的说法

看 `auth-core.js:497-530` 的 `refreshCredential`，以及 `isInvalidRefreshGrant`：

```js
if (isInvalidRefreshGrant(error)) {          // error.code === 'invalid_grant' && httpStatus === 400
    // 写入 anonymous 状态、删除凭据
    await this.options.credentialStore.delete(...);
    throw new AuthRequiredError({ cause: error });
}
```

以及 `auth-core.js:31` 的 `assertSameLoginEpoch`、`auth-core.js:198` 的 generation 比较：

```js
// Older callers cannot prove that a newer generation belongs to their login.
if (current.credential.generation > context.generation) ...
```

**机制**：服务端把 refresh_token 视为**单次有效**（轮换制）。若两个程序同时用**同一个** refresh_token 去刷：

1. 程序 A 刷新成功 → 服务端作废旧 refresh_token，签发新的
2. 程序 B 拿着**已被作废的**旧 refresh_token 去刷 → 服务端回 `invalid_grant` (HTTP 400)
3. 程序 B 的 `auth-core` 逻辑：收到 `invalid_grant` → **判定登录已失效 → 删掉本地凭据**

第 3 步就是"挤下线"的真正含义：**不是服务端踢你，而是客户端自己删了凭据。**

桌面端为了防这个，才搞了一套复杂的自保机制：

| 机制 | 位置 | 作用 |
|---|---|---|
| `CrossProcessAuthLock` | `cross-process-lock.js` | 跨进程文件锁，同一时刻只有一个进程能刷 |
| `generation` 单调递增 | 全流程 | 识别"我手上的凭据是不是过时了" |
| `loginEpoch` UUID | `auth-core.js:590` | 区分"同一登录的不同刷新"与"换了个账号" |
| `authorizationLeaseMs = 10min` | `auth-core.js:7` | 授权过程租约，防重复授权 |
| `refreshing` 状态落盘 | `auth-core.js:498` | 崩溃后能恢复"正在刷新中" |

**这整套东西存在的唯一理由，就是让"多方并发刷新"不出事。**

## 四、对 minimax-proxy 的直接影响

现有红线（`auth.ts:4-9`）说的是"会消耗磁盘上的 refresh_token 而不写回"——
**这个判断在"只读不写回"的前提下是对的**，但结论过头了：

- ❌ 不必然导致登出——只要**刷完把新 refresh_token 原子写回同一个 auth.json**
- ❌ 不必然与桌面端冲突——只要**复用桌面端的跨进程锁**（`cross-process-lock.js`，同一把锁文件）

### 安全自主刷新的三个必要条件

1. **拿到 cross-process lock**（同一锁路径，与桌面端互斥）
2. **刷完原子写回** auth.json（accessToken + refreshToken + expiresAtMs + generation+1）
3. **generation/loginEpoch 语义对齐**，并处理 `invalid_grant`（那才是真的该登出）

只做 1+2 不做 3，会在边缘情况下误判；三者齐备才与桌面端等价。

## 五、其他发现（顺带）

- **`standardInstallDirs()` 未覆盖本机安装路径**：实际装在 `D:\Software\MiniMaxCode\MiniMax Code\`，
  而代理只找 `%LOCALAPPDATA%\Programs`、`Program Files` 等标准位置。
  → 当前"自动拉起桌面端"在本机实际是**靠注册表回退**才找到的，或根本没找到。
- **`en` 区域从未登录**：磁盘上没有 `~\.minimax\auth\prod\en\mcode-public\auth.json`，
  所以 39306 端口必然 `signed-out`，与本问题无关。
- app.asar 里还打包了 OpenAI Codex 的 OAuth（`auth.openai.com`，client_id `app_EMoamEEZ73f0CkXaXp7hrann`），
  那是"用 Codex 账号接 MiniMax Code"的功能，与 MiniMax 自有登录无关，不要混淆。

## 六、结论

| 方案 | 可行性 | 风险 |
|---|---|---|
| A. 保持现状（开桌面端） | 可行但烦 | 无 |
| B. 代理自主刷新，**完整复刻** oauth-core 的锁+generation+原子写 | **技术可行** | 中（实现复杂度；一旦与桌面端锁策略不一致仍会互踩）|
| C. 代理自主刷新，**简陋版**（只刷+写回，不处理锁/generation） | 代码少 | **高**（与桌面端并发时会触发 invalid_grant → 双方都可能删凭据）|
| D. 请求时自动拉起桌面端（把现有 signin 的拉起逻辑接到请求路径） | 可行 | 低（沿用现有已验证的 launcher 机制）|

**如果只求"不用手动开"，D 最稳**：桌面端自己就是最正确的刷新者，代理只需在 token 过期时把它叫起来 15~25 秒。
**如果追求"彻底不依赖桌面端"，B 才是正解**，但那等于自己重写一遍官方那套并发保护。
