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

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { redactPaths } from './redact.ts'

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
  /** 上次解析结果的「文件签名」（mtimeMs:size）缓存，避免对未变化文件重复读盘。 */
  private cacheSignature = ''
  private cacheResult: { record?: RawRecord; filePath: string } | undefined

  constructor(region: MiniMaxRegion) {
    this.region = region
  }

  /**
   * 读取并解析 auth.json。
   *
   * 性能：以 `mtimeMs + size` 作为缓存门禁——签名不变则直接复用上次解析结果，
   * 让 /status、hasCredential、resolve 的重复调用不再反复读同一份文件。
   *
   * 正确性：只缓存「文件内容」，**绝不缓存对过期与否的判断**；过期与否每次都由
   * 调用方按 expiresAtMs 与当前时间现算，所以 token 到点仍会被即时发现。
   * 续期会重写文件（mtime/size 必变），文件被删除时 stat 失败即清空缓存，
   * 两种情况都会触发重读，不会拿旧 token 冒充当前登录态。
   */
  private async readRecord(): Promise<{ record?: RawRecord; filePath: string }> {
    const filePath = authFileOf(this.region)
    let signature: string
    try {
      const info = await stat(filePath)
      signature = `${info.mtimeMs}:${info.size}`
    } catch {
      // 文件不存在/不可读：必须清空缓存，不得用旧记录冒充当前登录态
      this.cacheSignature = ''
      this.cacheResult = undefined
      return { filePath }
    }
    if (this.cacheResult !== undefined && signature === this.cacheSignature) return this.cacheResult

    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      return { filePath }
    }
    let result: { record?: RawRecord; filePath: string } = { filePath }
    try {
      const parsed = JSON.parse(raw) as { records?: Record<string, RawRecord> }
      const records = parsed.records
      if (records && typeof records === 'object') {
        const key = Object.keys(records).find(k => k.includes('oauth'))
        if (key !== undefined) result = { record: records[key], filePath }
      }
    } catch {
      // 解析失败按「无记录」处理（文件被写坏时的瞬时状态）
    }
    this.cacheSignature = signature
    this.cacheResult = result
    return result
  }

  /**
   * 由原始记录构造凭据；任何不可用情况都抛 MiniMaxAuthError（绝不触发刷新）。
   */
  private credentialFrom(record: RawRecord, filePath: string): MiniMaxCredential {
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

  /**
   * 解析当前可用的 access token。任何不可用情况都抛错（由 shim 映射为 401/503），
   * 绝不触发刷新。
   */
  async resolve(): Promise<MiniMaxCredential> {
    const { record, filePath } = await this.readRecord()
    if (!record) {
      throw new MiniMaxAuthError('signed-out', `未找到 ${REGIONS[this.region].label}登录态，请先登录 MiniMax Code 桌面端`)
    }
    return this.credentialFrom(record, filePath)
  }

  /**
   * 轻量判断：该区域是否存在任何 OAuth 记录（不校验有效期、不抛错、不碰进程）。
   * 用于在「自动拉起桌面端」前先排除「从未登录此区域」的情况，避免无谓启动程序。
   */
  async hasCredential(): Promise<boolean> {
    const { record } = await this.readRecord()
    return record !== undefined
  }

  async status(): Promise<AuthStatus> {
    const hint = await readAccountHint(this.region)
    // 单次读取 auth.json 并复用同一份记录（不再经 resolve() 触发第二次解析）；
    // 账号昵称来自桌面端另一份配置文件（readAccountHint），与本文件无关，无法合并。
    const { record, filePath } = await this.readRecord()
    try {
      if (!record) {
        throw new MiniMaxAuthError('signed-out', `未找到 ${REGIONS[this.region].label}登录态，请先登录 MiniMax Code 桌面端`)
      }
      const cred = this.credentialFrom(record, filePath)
      return {
        state: 'signed-in',
        region: this.region,
        account: hint.account,
        userID: hint.userID,
        expiresAtMs: cred.expiresAtMs,
        remainingSec: Math.max(0, Math.round((cred.expiresAtMs - Date.now()) / 1000)),
        filePath: redactPaths(cred.filePath),
      }
    } catch (error) {
      const kind = error instanceof MiniMaxAuthError ? error.kind : 'signed-out'
      return {
        state: kind === 'expired' ? 'expired' : 'signed-out',
        region: this.region,
        account: hint.account,
        userID: hint.userID,
        filePath: redactPaths(authFileOf(this.region)),
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
