/**
 * 只读 MiniMax Code（mcode）登录态。
 *
 * 设计红线（踩过坑）：MiniMax 的 refresh_token 是**一次性轮换**的，且与桌面端共享。
 * 若本代理主动调用 /oauth2/token 刷新，会消耗磁盘上的 refresh_token 而不写回，
 * 桌面端随后检测到失效会把登录态清空（强制登出）。因此本模块：
 *   - 只读 accessToken，绝不使用 refreshToken、绝不发起刷新、绝不写文件；
 *   - access token（约 1 小时）由 MiniMax Code 桌面端自行续期，代理每次请求实时重读；
 *   - 过期/缺失时返回 signed-out/expired，提示打开桌面端，而不是自行刷新。
 *
 * @module minimax-proxy/auth
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type MiniMaxRegion = 'cn' | 'en'

export interface RegionEndpoint {
  region: MiniMaxRegion
  /** Anthropic 兼容 Messages 基址（末尾不带斜杠），SDK/客户端在其后拼 /messages */
  messagesBaseUrl: string
  /** 登录态目录名 */
  authDir: string
  label: string
}

export const REGIONS: Record<MiniMaxRegion, RegionEndpoint> = {
  cn: {
    region: 'cn',
    messagesBaseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
    authDir: 'cn',
    label: '国内版',
  },
  en: {
    region: 'en',
    messagesBaseUrl: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
    authDir: 'en',
    label: '国际版',
  },
}

export interface MiniMaxCredential {
  region: MiniMaxRegion
  accessToken: string
  expiresAtMs: number
  clientId: string
  loginEpoch?: string
  filePath: string
}

export interface AuthStatus {
  state: 'signed-in' | 'expired' | 'signed-out'
  region: MiniMaxRegion
  account?: string
  userID?: string
  expiresAtMs?: number
  remainingSec?: number
  filePath?: string
  message?: string
}

const EXPIRY_SKEW_MS = 60 * 1000

function authDirOf(region: MiniMaxRegion): string {
  return join(homedir(), '.minimax', 'auth', 'prod', REGIONS[region].authDir, 'mcode-public')
}

function authFileOf(region: MiniMaxRegion): string {
  return join(authDirOf(region), 'auth.json')
}

/** 桌面端配置（含用户昵称/ID），仅用于 /status 展示，失败不影响主流程。 */
async function readAccountHint(region: MiniMaxRegion): Promise<{ account?: string; userID?: string }> {
  try {
    const candidates = region === 'cn'
      ? [join(process.env['APPDATA'] ?? '', 'MiniMax', 'minimax-agent-cn-config.json')]
      : [join(process.env['APPDATA'] ?? '', 'MiniMax', 'minimax-agent-config.json')]
    for (const fp of candidates) {
      const raw = await readFile(fp, 'utf8')
      const j = JSON.parse(raw) as { sharedUser?: { subUserName?: string; userName?: string; userID?: string } }
      const u = j.sharedUser
      if (u) return { account: u.subUserName ?? u.userName, userID: u.userID }
    }
  } catch {
    // 忽略
  }
  return {}
}

interface RawRecord {
  accessToken?: unknown
  refreshToken?: unknown
  tokenType?: unknown
  clientId?: unknown
  audience?: unknown
  expiresAtMs?: unknown
  loginEpoch?: unknown
}

export class LiveMiniMaxStore {
  private readonly region: MiniMaxRegion
  constructor(region: MiniMaxRegion) {
    this.region = region
  }

  private async readRecord(): Promise<{ record?: RawRecord; filePath: string }> {
    const filePath = authFileOf(this.region)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      return { filePath }
    }
    let parsed: { records?: Record<string, RawRecord> }
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { filePath }
    }
    const records = parsed.records
    if (!records || typeof records !== 'object') return { filePath }
    const key = Object.keys(records).find(k => k.includes('oauth'))
    if (key === undefined) return { filePath }
    return { record: records[key], filePath }
  }

  /**
   * 解析当前可用的 access token。任何不可用情况都抛错（由 shim 映射为 401/503），
   * 绝不触发刷新。
   */
  async resolve(): Promise<MiniMaxCredential> {
    const { record, filePath } = await this.readRecord()
    if (!record) {
      throw new MiniMaxAuthError('signed-out', `未找到 ${REGIONS[this.region].label}登录态，请先登录 MiniMax Code 桌面端`)
    }
    const accessToken = typeof record.accessToken === 'string' ? record.accessToken : ''
    const expiresAtMs = typeof record.expiresAtMs === 'number' ? record.expiresAtMs : 0
    if (accessToken === '') {
      throw new MiniMaxAuthError('signed-out', '登录态缺少 accessToken，请重新登录 MiniMax Code 桌面端')
    }
    if (expiresAtMs > 0 && Date.now() >= expiresAtMs - EXPIRY_SKEW_MS) {
      throw new MiniMaxAuthError('expired', 'access token 已过期；请打开 MiniMax Code 桌面端让其自动续期（本代理不主动刷新）')
    }
    return {
      region: this.region,
      accessToken,
      expiresAtMs,
      clientId: typeof record.clientId === 'string' ? record.clientId : 'mcode-public',
      loginEpoch: typeof record.loginEpoch === 'string' ? record.loginEpoch : undefined,
      filePath,
    }
  }

  async status(): Promise<AuthStatus> {
    const hint = await readAccountHint(this.region)
    try {
      const cred = await this.resolve()
      return {
        state: 'signed-in',
        region: this.region,
        account: hint.account,
        userID: hint.userID,
        expiresAtMs: cred.expiresAtMs,
        remainingSec: Math.max(0, Math.round((cred.expiresAtMs - Date.now()) / 1000)),
        filePath: cred.filePath,
      }
    } catch (error) {
      const kind = error instanceof MiniMaxAuthError ? error.kind : 'signed-out'
      return {
        state: kind === 'expired' ? 'expired' : 'signed-out',
        region: this.region,
        account: hint.account,
        userID: hint.userID,
        filePath: authFileOf(this.region),
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

export class MiniMaxAuthError extends Error {
  readonly kind: 'signed-out' | 'expired'
  constructor(kind: 'signed-out' | 'expired', message: string) {
    super(message)
    this.name = 'MiniMaxAuthError'
    this.kind = kind
  }
}
