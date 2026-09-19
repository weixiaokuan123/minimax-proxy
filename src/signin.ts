/**
 * MiniMax Code（mcode）每日签到客户端与面板解析。
 *
 * 端点（均在 agent 网关，Bearer 鉴权，时区走 query）：
 *   GET  /minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
 *   POST /minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   （空 body）
 *
 * 面板为 7 天：每日 status 1 未开始 / 2 可领 / 3 已领 / 4 不可领；
 * claim 返回 claim_result 1 本次领取 / 2 今天已领（幂等）。
 *
 * 只读 access token，绝不刷新。
 *
 * @module minimax-proxy/signin
 */

import type { MiniMaxCredential, MiniMaxRegion, RegionEndpoint } from './auth.ts'
import { REGIONS } from './auth.ts'

export const SIGNIN_DAY_UPCOMING = 1
export const SIGNIN_DAY_CLAIMABLE = 2
export const SIGNIN_DAY_CLAIMED = 3
export const SIGNIN_DAY_DISABLED = 4

export const CLAIM_RESULT_CLAIMED = 1
export const CLAIM_RESULT_ALREADY = 2

export interface SigninDay {
  dayNo: number
  points: number
  status: number
  isToday: boolean
}

export interface SigninPanel {
  scene: number
  days: SigninDay[]
}

export interface SigninSnapshot {
  checkedInToday: boolean
  claimableToday: boolean
  todayPoints: number
  streak: number
  panel: SigninPanel
}

export interface ClaimOutcome {
  claimed: boolean
  already: boolean
  message: string
  points?: number
  streak?: number
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

function parsePanel(value: unknown): SigninPanel {
  const panel = value as { scene?: unknown; days?: unknown }
  if (!panel || typeof panel !== 'object' || !Array.isArray(panel.days)) {
    throw new Error('签到面板数据缺失')
  }
  const days: SigninDay[] = panel.days.map((raw) => {
    const d = raw as Record<string, unknown>
    return {
      dayNo: Number(d['day_no']),
      points: Number(d['points'] ?? 0),
      status: Number(d['status']),
      isToday: d['is_today'] === true,
    }
  })
  return { scene: Number(panel.scene ?? 0), days }
}

/** 连续签到天数：从今天（已领）或昨天（今天可领未领）向前数连续 Claimed。 */
export function getStreak(panel: SigninPanel): number {
  const sorted = [...panel.days].sort((a, b) => a.dayNo - b.dayNo)
  const todayIndex = sorted.findIndex(d => d.isToday)
  if (todayIndex < 0) return 0
  const todayStatus = sorted[todayIndex]?.status
  let index = todayStatus === SIGNIN_DAY_CLAIMED
    ? todayIndex
    : todayStatus === SIGNIN_DAY_CLAIMABLE
      ? todayIndex - 1
      : -1
  if (index < 0) return 0
  let streak = 0
  for (; index >= 0; index -= 1) {
    if (sorted[index]?.status !== SIGNIN_DAY_CLAIMED) break
    streak += 1
  }
  return streak
}

function summarize(panel: SigninPanel): SigninSnapshot {
  const today = panel.days.find(d => d.isToday)
  return {
    checkedInToday: today?.status === SIGNIN_DAY_CLAIMED,
    claimableToday: today?.status === SIGNIN_DAY_CLAIMABLE,
    todayPoints: today?.points ?? 0,
    streak: getStreak(panel),
    panel,
  }
}

export class MiniMaxSigninClient {
  private readonly endpoint: RegionEndpoint
  private readonly tz: string
  readonly region: MiniMaxRegion

  constructor(region: MiniMaxRegion, tz?: string) {
    this.region = region
    this.endpoint = REGIONS[region]
    // messagesBaseUrl 形如 https://agent.minimax.cn/mavis/api/v1/llm/v1
    // 签到根为同源的 https://agent.minimax.cn
    this.tz = tz ?? localTimezone()
  }

  private origin(): string {
    const u = new URL(this.endpoint.messagesBaseUrl)
    return u.origin
  }

  private headers(cred: MiniMaxCredential): Record<string, string> {
    return {
      'Authorization': `Bearer ${cred.accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }
  }

  async getPanel(cred: MiniMaxCredential, signal?: AbortSignal): Promise<SigninSnapshot> {
    const url = `${this.origin()}/minimax-cloud/api/v1/signin/status?timezone_id=${encodeURIComponent(this.tz)}`
    const res = await fetch(url, { method: 'GET', headers: this.headers(cred), signal })
    const body = await res.json().catch(() => null) as { base_resp?: { status_code?: number; status_msg?: string }; data?: unknown } | null
    const code = body?.base_resp?.status_code
    if (!res.ok || (code !== undefined && code !== 0)) {
      throw new Error(`签到状态查询失败 HTTP ${res.status} ${body?.base_resp?.status_msg ?? ''}`.trim())
    }
    return summarize(parsePanel(body?.data))
  }

  async claim(cred: MiniMaxCredential, signal?: AbortSignal): Promise<ClaimOutcome> {
    // 先查面板，已领则零写入，幂等
    const before = await this.getPanel(cred, signal)
    if (before.checkedInToday) {
      return { claimed: false, already: true, message: `今天已签到（连签 ${before.streak} 天）`, streak: before.streak }
    }
    if (!before.claimableToday) {
      return { claimed: false, already: false, message: '今天暂不可领（未到可领状态）', streak: before.streak }
    }

    const url = `${this.origin()}/minimax-cloud/api/v1/signin/claim?timezone_id=${encodeURIComponent(this.tz)}`
    const res = await fetch(url, { method: 'POST', headers: this.headers(cred), body: '{}', signal })
    const body = await res.json().catch(() => null) as {
      base_resp?: { status_code?: number; status_msg?: string }
      data?: { claim_result?: number; points?: number; day_no?: number; expire_at_ms?: number; panel?: unknown }
    } | null
    const code = body?.base_resp?.status_code
    if (!res.ok || (code !== undefined && code !== 0)) {
      throw new Error(`签到领取失败 HTTP ${res.status} ${body?.base_resp?.status_msg ?? ''}`.trim())
    }
    const data = body?.data
    const result = data?.claim_result
    if (result === CLAIM_RESULT_ALREADY) {
      return { claimed: false, already: true, message: '今天已签到（服务端确认）' }
    }
    const points = typeof data?.points === 'number' ? data.points : before.todayPoints
    const afterPanel = data?.panel ? summarize(parsePanel(data.panel)) : await this.getPanel(cred, signal).catch(() => before)
    return {
      claimed: true,
      already: false,
      points,
      streak: afterPanel.streak,
      message: `签到成功，+${points} 积分（连签 ${afterPanel.streak} 天）`,
    }
  }
}
