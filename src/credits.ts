/**
 * MiniMax 账户积分（credit）查询。
 *
 * 上游是 `GET /minimax-cloud/api/v1/credit/details`，返回 `details[]`，每笔形如：
 *
 *   { granted_at_ms, expire_at_ms, credit_type,
 *     granted_amount: "800.00", remaining_amount: "800.00", consumed_amount: "0.00" }
 *
 * 三个实测踩到的点：
 *   1. **金额是字符串**（`"800.00"`），当数字用会得到 NaN；
 *   2. **用完的额度仍留在列表里**——实测 13 笔里 8 笔 `remaining=0`，不剔就等于
 *      面板上多出 8 个空的到期组；
 *   3. 每笔有明确 `expire_at_ms`（实测发放后 30 天到期），所以可以按到期日聚合。
 *
 * 本模块只做**解析**：请求由 {@link fetchMinimaxCredits} 发，缓存见 {@link CreditsCache}。
 *
 * @module minimax-proxy/credits
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 一笔积分额度。**字段名刻意与 workbuddy 的 `WorkBuddyCreditPackage` 对齐**，
 * 这样 agent-hub 面板的 `groupCreditPackages()` 能原样复用，不必写第二套聚合。
 */
export interface MiniMaxCreditPackage {
  /** 剩余可用。 */
  remain: number
  /** 发放总量。 */
  size: number
  /** 已消耗。 */
  consumed: number
  /** 到期时刻（ms）。 */
  expiresAtMs: number
  /** MiniMax 没有月度包；恒为 false，纯粹为了让面板的判断不落到 undefined。 */
  monthly: boolean
}

export interface MiniMaxCredits {
  /** 当前余额 = 各笔剩余之和。 */
  total: number
  /** 还有余额的额度笔数（已用完的已剔除）。 */
  packages: MiniMaxCreditPackage[]
  /** 距离 now+windowMs 以内到期的剩余额度之和。 */
  expiringSoon: number
  /** 最近一笔到期的时刻（ms）；没有可用额度时为 undefined。 */
  nearestExpiryMs?: number
}

/** 把上游的字符串金额变成数字；任何异常都归 0，绝不产出 NaN。 */
function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 解析上游 `credit/details` 响应。
 *
 * 全程降级：上游给 `null`、结构不对、某一笔是垃圾，都不该让面板整个崩掉——
 * 实测这个接口是"能查到就查"，查不到也要能正常降级成 0。
 */
export function parseCreditDetails(body: unknown, nowMs: number = Date.now()): MiniMaxCredits {
  const empty: MiniMaxCredits = { total: 0, packages: [], expiringSoon: 0 }
  if (typeof body !== 'object' || body === null) return empty
  const details = (body as { details?: unknown }).details
  if (!Array.isArray(details)) return empty

  const packages: MiniMaxCreditPackage[] = []
  for (const raw of details) {
    if (typeof raw !== 'object' || raw === null) continue
    const o = raw as Record<string, unknown>
    const remain = amount(o['remaining_amount'])
    // 用完的额度仍在列表里，剔掉——否则面板上会多出一堆空的到期组。
    // 顺带把负数也在这里挡掉。
    if (remain <= 0) continue
    const expiresAtMs = typeof o['expire_at_ms'] === 'number' ? o['expire_at_ms'] : 0
    if (expiresAtMs <= 0) continue
    packages.push({
      remain,
      size: amount(o['granted_amount']),
      consumed: amount(o['consumed_amount']),
      expiresAtMs,
      monthly: false,
    })
  }

  const total = packages.reduce((s, p) => s + p.remain, 0)
  const nearestExpiryMs = packages.length > 0 ? Math.min(...packages.map(p => p.expiresAtMs)) : undefined
  // 默认口径：7 天内到期。面板与代理共用同一个常量，避免两边算出不同结果。
  const expiringSoon = packages
    .filter(p => p.expiresAtMs - nowMs <= 7 * DAY_MS && p.expiresAtMs > nowMs)
    .reduce((s, p) => s + p.remain, 0)
  return { total, packages, expiringSoon, ...(nearestExpiryMs === undefined ? {} : { nearestExpiryMs }) }
}

/**
 * 提醒用：窗口内还有多少分、几笔。
 *
 * **已过期的额度不计入**——它们已经在上游的账上作废了，再提醒一次等于每天
 * 甩一条永远消不掉的僵尸提醒。
 */
export function creditsExpiringWithinMs(
  c: MiniMaxCredits,
  nowMs: number = Date.now(),
  windowMs: number = 7 * DAY_MS,
): { amount: number; count: number } {
  let amountSum = 0
  let count = 0
  for (const p of c.packages) {
    const delta = p.expiresAtMs - nowMs
    if (delta <= 0) continue
    if (delta > windowMs) continue
    amountSum += p.remain
    count++
  }
  return { amount: amountSum, count }
}

/** 请求上游。`cred.accessToken` 已在调用方解析，这里只管发与解包。 */
export async function fetchMinimaxCredits(
  origin: string,
  accessToken: string,
  tz: string,
  signal?: AbortSignal,
): Promise<MiniMaxCredits> {
  const url = `${origin}/minimax-cloud/api/v1/credit/details?timezone_id=${encodeURIComponent(tz)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    ...(signal === undefined ? {} : { signal }),
  })
  const body = await res.json().catch(() => null) as {
    base_resp?: { status_code?: number; status_msg?: string }
    details?: unknown
  } | null
  const code = body?.base_resp?.status_code
  if (!res.ok || (code !== undefined && code !== 0)) {
    throw new Error(`积分查询失败 HTTP ${res.status} ${body?.base_resp?.status_msg ?? ''}`.trim())
  }
  return parseCreditDetails(body)
}

/**
 * 积分缓存。
 *
 * 积分变化不频繁（签到才加），60 秒足够。面板每 15 分钟刷一次，代理的 /status
 * 也会读，所以不加缓存就是每轮都打一次上游。
 */
export class CreditsCache {
  private entry: { value: MiniMaxCredits; atMs: number } | undefined
  private inflight: Promise<MiniMaxCredits> | undefined
  private readonly ttlMs: number
  private readonly now: () => number

  // 刻意不用构造函数参数属性（`private readonly x` 简写）——Node 的类型擦除
  // 是 strip-only 模式，不支持那种语法，编译期才发现不了。
  constructor(ttlMs: number = 60_000, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs
    this.now = now
  }

  async get(loader: () => Promise<MiniMaxCredits>): Promise<{ credits: MiniMaxCredits; cached: boolean; ageSec: number }> {
    const nowMs = this.now()
    const hit = this.entry
    if (hit !== undefined && nowMs - hit.atMs < this.ttlMs) {
      return { credits: hit.value, cached: true, ageSec: Math.round((nowMs - hit.atMs) / 1000) }
    }
    // single-flight：并发请求共享同一次上游调用
    if (this.inflight !== undefined) return { credits: await this.inflight, cached: true, ageSec: 0 }
    const task = loader()
      .then(credits => {
        this.entry = { value: credits, atMs: this.now() }
        return credits
      })
      .finally(() => { this.inflight = undefined })
    this.inflight = task
    return { credits: await task, cached: false, ageSec: 0 }
  }
}
