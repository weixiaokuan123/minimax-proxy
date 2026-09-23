import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 桌面端会话管理：跟踪「代理拉起的桌面端」并按其空闲时长自动退出。
 *
 * 设计要点（避免误杀用户正在使用的窗口）：
 *  - 只对**代理自己拉起**的桌面端负责：用户手动开的实例永不触碰（ownership 标记）；
 *  - 「空闲」以**代理是否收到请求**为准（由 shim 在每次请求时 touch）；
 *  - 空闲达到阈值才退出；只要还有请求进来就会不断续命；
 *  - 退出前再确认一次「仍然空闲」，避免在最后一次 touch 与退出检查之间刚好来请求；
 *  - ownership **持久化到磁盘**：代理重启（或开机自启）后仍能接管自己拉起的桌面端，
 *    否则重启即失忆，桌面端会永久残留——那正是「必须一直开着」问题的另一种形态。
 *
 * @module minimax-proxy/session
 */

/** 空闲判定与退出所需的全部外部依赖（便于测试注入）。 */
export interface IdleSessionOptions {
  /** 空闲多久后退出（ms），默认 20 分钟。 */
  idleMs?: number
  /** 检查间隔（ms），默认 30 秒。 */
  tickMs?: number
  /** 当前时间源，默认 Date.now。 */
  now?: () => number
  /** 结束桌面端（返回最终存活进程数）。 */
  terminate: () => Promise<number>
  /** 日志。 */
  log?: (message: string) => void
  /** ownership 持久化文件；不提供则仅内存（进程重启后失忆）。 */
  stateFile?: string
}

/** 落盘的 ownership 记录。 */
interface PersistedOwnership {
  /** 是否由代理拉起。 */
  owned: boolean
  /** 最后一次活动时间（ms）。 */
  lastActivityMs: number
  /** 写入时间，用于诊断。 */
  writtenAtMs: number
}

/**
 * 跟踪「代理拉起的桌面端」的归属与空闲状态。
 *
 * 生命周期：
 *   markStarted()  → 代理拉起桌面端成功
 *   touch()        → 每次代理收到请求（续命）
 *   tick()         → 周期性检查，空闲超时则 terminate 并清除归属
 *   markStopped()  → 桌面端已被退出/确认不再运行
 */
export class DesktopSession {
  private startedByUs = false
  private lastActivityMs = 0
  private terminating = false
  private readonly idleMs: number
  private readonly now: () => number
  private readonly terminate: () => Promise<number>
  private readonly log: (message: string) => void
  private readonly stateFile: string | undefined

  constructor(options: IdleSessionOptions) {
    this.idleMs = options.idleMs ?? 20 * 60 * 1000
    this.now = options.now ?? Date.now
    this.terminate = options.terminate
    this.log = options.log ?? (() => {})
    this.stateFile = options.stateFile
  }

  /** 落盘 ownership（失败不影响主流程——最坏情况是重启后失忆）。 */
  private async persist(): Promise<void> {
    if (this.stateFile === undefined) return
    try {
      await mkdir(dirname(this.stateFile), { recursive: true })
      const record: PersistedOwnership = {
        owned: this.startedByUs,
        lastActivityMs: this.lastActivityMs,
        writtenAtMs: this.now(),
      }
      await writeFile(this.stateFile, JSON.stringify(record, null, 2) + '\n', 'utf8')
    } catch {
      // 忽略：持久化失败只是重启后不再自动接管
    }
  }

  /**
   * 从磁盘恢复 ownership（进程启动时调用）。
   *
   * 关键：恢复出的 lastActivityMs 若已超过一个空闲周期，说明代理停机期间早已空闲，
   * 此时**立即按已超时处理**（把 lastActivityMs 前推到刚好超时），
   * 而不是从 0 重新计时——否则重启一次就白白多留一个完整周期。
   *
   * @param isDesktopRunning 桌面端当前是否真的在运行；不在运行则清除 ownership
   */
  async restore(isDesktopRunning: boolean): Promise<boolean> {
    if (this.stateFile === undefined) return false
    let record: PersistedOwnership
    try {
      record = JSON.parse(await readFile(this.stateFile, 'utf8')) as PersistedOwnership
    } catch {
      return false
    }
    if (record.owned !== true) return false
    if (!isDesktopRunning) {
      // 桌面端已经不在运行（可能被用户关了）：清除记录，不再跟踪
      this.startedByUs = false
      this.lastActivityMs = 0
      await this.persist()
      return false
    }
    this.startedByUs = true
    this.lastActivityMs = typeof record.lastActivityMs === 'number' ? record.lastActivityMs : 0
    this.log(
      `minimax: 已接管上次由代理拉起的桌面端（上次活动 ${Math.round((this.now() - this.lastActivityMs) / 1000)}s 前）`,
    )
    await this.persist()
    return true
  }

  /** 记录「桌面端由代理本次拉起」。 */
  markStarted(): void {
    this.startedByUs = true
    this.lastActivityMs = this.now()
    void this.persist()
  }

  /** 桌面端已不在运行（被用户关闭或已退出）：清除归属，不再跟踪。 */
  markStopped(): void {
    this.startedByUs = false
    this.terminating = false
    void this.persist()
  }

  /** 每次代理收到请求时调用，用于续命。 */
  touch(): void {
    this.lastActivityMs = this.now()
    void this.persist()
  }

  get owned(): boolean {
    return this.startedByUs
  }

  /** 距上次活动过了多少毫秒。 */
  idleForMs(): number {
    if (this.lastActivityMs === 0) return 0
    return this.now() - this.lastActivityMs
  }

  /**
   * 周期检查：若桌面端由我们拉起且已空闲超时，则退出它。
   * @returns true 表示本次真的执行了退出
   */
  async tick(): Promise<boolean> {
    if (!this.startedByUs || this.terminating) return false
    if (this.lastActivityMs === 0) return false
    if (this.idleForMs() < this.idleMs) return false

    // 退出前二次确认「仍然空闲」：从判定到真正杀进程之间可能刚好来了请求
    if (this.idleForMs() < this.idleMs) return false

    this.terminating = true
    const idleSec = Math.round(this.idleForMs() / 1000)
    try {
      this.log(`minimax: 桌面端空闲 ${idleSec}s（阈值 ${Math.round(this.idleMs / 1000)}s），退出由代理拉起的实例`)
      const remaining = await this.terminate()
      if (remaining > 0) {
        // 没杀干净：保留 ownership，下个 tick 继续尝试
        this.log(`minimax: 桌面端仍有 ${remaining} 个进程存活，稍后重试`)
        return true
      }
      this.startedByUs = false
      await this.persist()
      this.log('minimax: 已退出由代理拉起的桌面端')
      return true
    } catch (error) {
      this.log(`minimax: 退出桌面端失败：${String(error)}`)
      return true
    } finally {
      this.terminating = false
    }
  }
}
