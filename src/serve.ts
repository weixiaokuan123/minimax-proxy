/**
 * minimax-proxy 守护入口：一个进程同时服务国内(cn)与国际(en)两个回环端点。
 *
 * 仅依赖 Node 内置能力，TypeScript 由 Node 22.19+/24 的类型擦除直接运行，无需构建。
 * 上游为 MiniMax Code（mcode）原生 Anthropic 兼容网关，本进程只读桌面端登录态、
 * 原样透传，绝不主动刷新令牌（避免一次性 refresh_token 把桌面端挤下线）。
 *
 * @module minimax-proxy/serve
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveMiniMaxStore, MiniMaxAuthError, type MiniMaxRegion } from './auth.ts'
import { MiniMaxCatalog } from './catalog.ts'
import { createMiniMaxShim, type MiniMaxShim, type ShimLogger } from './shim.ts'
import { MiniMaxUpstreamClient } from './upstream.ts'
import { MiniMaxSigninClient } from './signin.ts'
import { SigninScheduler, formatSec } from './scheduler.ts'
import { isRunning, launchDesktop, minimizeDesktopWindowWhenReady, terminateDesktop, waitForTokenReady } from './launcher.ts'
import { DesktopSession } from './session.ts'

import { redactPaths } from './redact.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const KEYS_DIR = join(ROOT, 'keys')
const STATE_DIR = join(ROOT, 'state')

const SIGNIN_ENABLED = (process.env['MINIMAX_SIGNIN'] ?? 'on') !== 'off'
const SIGNIN_START_HOUR = Number(process.env['MINIMAX_SIGNIN_START_HOUR'] ?? 7)
const SIGNIN_END_HOUR = Number(process.env['MINIMAX_SIGNIN_END_HOUR'] ?? 10)
const SIGNIN_TICK_MS = 5 * 60 * 1000
const SIGNIN_INITIAL_DELAY_MS = 60 * 1000

/** token 过期时自动拉起 MiniMax Code 桌面端续期+签到，签完退出（默认开）。 */
const AUTO_LAUNCH = (process.env['MINIMAX_AUTO_LAUNCH'] ?? 'on') !== 'off'
/** 等待桌面端续期的最长时间。 */
const LAUNCH_WAIT_MS = Number(process.env['MINIMAX_LAUNCH_WAIT_MS'] ?? 120_000)
/** 签到后等待桌面端进程树真正退出的最长时间。 */
const QUIT_WAIT_MS = Number(process.env['MINIMAX_QUIT_WAIT_MS'] ?? 30_000)
/** 代理拉起的桌面端空闲多久后自动退出（默认 20 分钟；0 表示不自动退出）。 */
const IDLE_EXIT_MS = Number(process.env['MINIMAX_IDLE_EXIT_MS'] ?? 20 * 60 * 1000)
/** 空闲检查间隔。 */
const IDLE_TICK_MS = Number(process.env['MINIMAX_IDLE_TICK_MS'] ?? 30_000)
/**
 * 代理拉起桌面端后，是否顺手把它的窗口最小化到任务栏。
 * 桌面端写死了「启动即 show()+focus()」，只在代理拉起的实例上收窗口，
 * 用户手动打开的实例不动（方便正常使用界面）。
 */
const MINIMIZE_ON_LAUNCH = (process.env['MINIMAX_MINIMIZE_ON_LAUNCH'] ?? 'on') !== 'off'
/** 等待桌面端窗口出现并最小化的最长时间。 */
const MINIMIZE_WAIT_MS = Number(process.env['MINIMAX_MINIMIZE_WAIT_MS'] ?? 30_000)

const REGION_PORTS: Record<MiniMaxRegion, number> = {
  cn: Number(process.env['MINIMAX_CN_PORT'] ?? 39305),
  en: Number(process.env['MINIMAX_EN_PORT'] ?? 39306),
}

function ts(): string {
  return new Date().toISOString()
}

/**
 * 日志参数格式化。
 *
 * - 对象不再被 String() 压成 "[object Object]"，改为 JSON，保住诊断信息；
 * - 统一做路径脱敏：日志会追加落盘长期保存，不应写入本机用户名与目录结构。
 */
function fmtLogArgs(args: unknown[]): string {
  const text = args.map((a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return `${a.name}: ${a.message}`
    try { return JSON.stringify(a) ?? String(a) } catch { return String(a) }
  }).join(' ')
  return redactPaths(text)
}

/**
 * 日志落盘 + 运行期轮转。
 *
 * 历史上日志由 start.ps1 用 cmd 重定向（node ... >> out.log 2>> err.log），
 * 文件句柄在 cmd 手里 —— 本进程拿不到句柄，**无法在运行期轮转**，只能在重启时
 * 轮一次。后果是「长期不重启的进程，日志无上限增长」。
 *
 * 因此改为：若环境变量指明了日志路径，由本进程直接持有该文件并在超限时自行轮转；
 * 未设置（前台调试）时退回 stdout/stderr。
 *
 * 轮转策略与 start.ps1 里的 Rotate-Log 保持一致：超限改名为 .1，只保留一份。
 */

/** 单个日志文件上限，与 start.ps1 的 Rotate-Log 同一阈值。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024

interface LogSink {
  path: string
  /** 当前文件已有字节数，作为轮转基线。 */
  size: number
}

function makeLogSink(envKey: string): LogSink | null {
  const p = process.env[envKey]
  if (p === undefined || p.trim() === '') return null
  try {
    mkdirSync(dirname(p), { recursive: true })
    // 追加而非截断：既有内容保留，并把当前大小作为轮转基线
    return { path: p, size: statSync(p, { throwIfNoEntry: false })?.size ?? 0 }
  } catch {
    return null // 建不出来就退回 stdout/stderr，不让日志问题拦住启动
  }
}

function writeLogSink(sink: LogSink, text: string): void {
  const bytes = Buffer.byteLength(text)
  if (sink.size + bytes > LOG_MAX_BYTES) {
    try {
      rmSync(`${sink.path}.1`, { force: true })
      renameSync(sink.path, `${sink.path}.1`)
      sink.size = 0
    } catch {
      // 轮转失败就继续往当前文件追加：丢日志比不轮转更糟
    }
  }
  appendFileSync(sink.path, text, 'utf8')
  sink.size += bytes
}

const LOG_OUT = makeLogSink('MINIMAX_PROXY_LOG_OUT')
const LOG_ERR = makeLogSink('MINIMAX_PROXY_LOG_ERR')

function writeLog(level: 'info' | 'warn' | 'error', line: string): void {
  const sink = level === 'info' ? LOG_OUT : LOG_ERR
  if (sink !== null) writeLogSink(sink, line)
  else if (level === 'info') process.stdout.write(line)
  else process.stderr.write(line)
}

/** 日志重复抑制窗口：同一 level + 同一文本在该窗口内只输出一次。 */
const LOG_DEDUP_WINDOW_MS = 60_000
let lastLogKey = ''
/** 当前这段「相同日志连发」的起始时刻（不是上一条的时刻，见 shouldSuppressLog）。 */
let runStartedAtMs = 0
let suppressedLogCount = 0

/**
 * 连续重复日志抑制。
 *
 * 上游反复故障时（例如某区域长期未登录），同一条错误会被每个 tick 重记一次，
 * 既刷屏又放大磁盘写入。这里对「同一 level + 同一文本」在窗口内只输出首次。
 *
 * 窗口从**这段连发的第一条**开始算。若像原先那样在每次抑制时把计时基准顺延到
 * 当前时刻，窗口会被无限推迟 —— 同一条错误持续不断且期间没有别的日志时，
 * 「同类日志已抑制 N 条」就永远刷不出来，事后也看不出到底发生过多少次。
 * 现在窗口到期会先落盘计数、再让当前这条正常输出，保证每个窗口至少留一行可见。
 */
function shouldSuppressLog(key: string): { suppress: boolean; flushNote: string | null } {
  const now = Date.now()
  const sameKey = key === lastLogKey
  const windowExpired = now - runStartedAtMs >= LOG_DEDUP_WINDOW_MS

  if (suppressedLogCount > 0 && (!sameKey || windowExpired)) {
    const note = `（同类日志已抑制 ${suppressedLogCount} 条）`
    suppressedLogCount = 0
    lastLogKey = key
    runStartedAtMs = now
    return { suppress: false, flushNote: note }
  }
  if (sameKey && !windowExpired) {
    suppressedLogCount++
    return { suppress: true, flushNote: null }
  }
  lastLogKey = key
  runStartedAtMs = now
  return { suppress: false, flushNote: null }
}

function emitLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  const text = fmtLogArgs(args)
  const { suppress, flushNote } = shouldSuppressLog(`${level}:${text}`)
  const at = ts()
  if (flushNote !== null) writeLog(level, `[${at}] [${level}] ${flushNote}\n`)
  if (suppress) return
  writeLog(level, `[${at}] [${level}] ${text}\n`)
}

const logger: ShimLogger = {
  info: (...args) => emitLog('info', args),
  warn: (...args) => emitLog('warn', args),
  error: (...args) => emitLog('error', args),
}


async function loadOrCreateKey(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // 不存在则生成
  }
  const key = randomBytes(32).toString('base64url')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${key}\n`, { mode: 0o600 })
  return key
}

interface RegionRuntime {
  region: MiniMaxRegion
  store: LiveMiniMaxStore
  signin: MiniMaxSigninClient
  scheduler: SigninScheduler
}

const runtimes = new Map<MiniMaxRegion, RegionRuntime>()

/**
 * 桌面端只有一个（用户在哪个区域登录，它续的就是哪个区域的 token），
 * 因此归属与空闲状态是**全局共享**的，不按 region 分开。
 */
const desktopSession = new DesktopSession({
  idleMs: IDLE_EXIT_MS > 0 ? IDLE_EXIT_MS : Number.MAX_SAFE_INTEGER,
  stateFile: join(STATE_DIR, 'desktop-ownership.json'),
  log: m => logger.info(m),
  terminate: () => terminateDesktop({ timeoutMs: QUIT_WAIT_MS }),
})

/**
 * 确保该区域 token 可用：过期时拉起桌面端、等其续期写盘。
 * 供请求路径（shim.ensureToken）与签到路径共用。
 *
 * @returns 'already'（未过期，无需动作）| 'renewed'（本次拉起并成功续期）
 */
async function renewTokenIfNeeded(region: MiniMaxRegion): Promise<'already' | 'renewed'> {
  const rt = runtimes.get(region)
  if (rt === undefined) throw new Error(`minimax(${region}): 运行时未初始化`)
  if (!AUTO_LAUNCH) throw new Error('token 已过期且未开启自动拉起（MINIMAX_AUTO_LAUNCH=off）')

  const launch = await launchDesktop()
  if (launch.error) throw new Error(launch.error)
  if (launch.startedByUs) {
    desktopSession.markStarted()
    logger.info(`minimax(${region}): 已拉起桌面端续期，等待其写盘……`)
    // 桌面端自己会 show()+focus() 弹一个大窗口；代理随手把它收到任务栏，
    // 免得续期过程突然盖住你的桌面。不阻塞主流程（与等 token 并行）。
    if (MINIMIZE_ON_LAUNCH) {
      void minimizeDesktopWindowWhenReady({ timeoutMs: MINIMIZE_WAIT_MS }).then(ok => {
        if (ok) logger.info('minimax: 桌面端窗口已最小化到任务栏')
        else logger.warn('minimax: 未能最小化桌面端窗口（窗口可能未创建，不影响续期）')
      }).catch(() => { /* 最小化失败不影响续期 */ })
    }
  } else {
    logger.info(`minimax(${region}): 桌面端已在运行，等待其续期……`)
  }

  const ready = await waitForTokenReady({
    timeoutMs: LAUNCH_WAIT_MS,
    check: async () => {
      try { await rt.store.resolve(); return true } catch { return false }
    },
  })
  if (!ready) {
    // 拉起后仍拿不到 token（多半该区域未登录）：若桌面端是本会话拉起的，收掉它
    if (launch.startedByUs) {
      await terminateDesktop({ timeoutMs: QUIT_WAIT_MS }).catch(() => {})
      desktopSession.markStopped()
    }
    throw new Error('桌面端启动后未能在限定时间内续期 token（该区域可能未登录）')
  }
  return 'renewed'
}

async function buildRegion(region: MiniMaxRegion): Promise<MiniMaxShim> {
  const store = new LiveMiniMaxStore(region)
  const client = new MiniMaxUpstreamClient(region)
  const catalog = new MiniMaxCatalog(region)
  const signin = new MiniMaxSigninClient(region)
  // 签到状态按区域分文件：cn / en 各持一份，避免两个调度器各持内存副本
  // 整体回写同一文件时互相覆盖（丢更新）。
  const scheduler = new SigninScheduler({
    stateFile: join(STATE_DIR, `signin-state-${region}.json`),
    startHour: SIGNIN_START_HOUR,
    endHour: SIGNIN_END_HOUR,
    log: m => logger.info(m),
  })
  runtimes.set(region, { region, store, signin, scheduler })

  // 确保今天的随机时刻已生成（含国际区，未登录也无妨）
  const plan = await scheduler.plan(region)
  logger.info(`minimax(${region}) 今日签到计划 ${formatSec(plan.runAtSec)}`)

  const key = await loadOrCreateKey(join(KEYS_DIR, `${region}.key`))
  const shim = createMiniMaxShim({
    region,
    port: REGION_PORTS[region],
    token: key,
    store,
    client,
    catalog,
    logger,
    signinStatus: async () => {
      const entry = await scheduler.entry(region) ?? await scheduler.plan(region)
      let panel: unknown = null
      let panelError: string | undefined
      try {
        const cred = await store.resolve()
        panel = await signin.getPanel(cred)
      } catch (error) {
        panelError = error instanceof Error ? error.message : String(error)
      }
      return {
        region,
        scheduledAt: formatSec(entry.runAtSec),
        claimedToday: entry.claimed,
        lastResult: entry.result,
        panel,
        ...panelError === undefined ? {} : { panelError },
      }
    },
    signinClaim: async () => {
      const rt = runtimes.get(region)!
      const outcome = await scheduler.runNow(region, () => ensureSigned(rt, true))
      return { region, ...outcome }
    },
    // 请求路径：token 过期时自动拉起桌面端续期（续期后桌面端留着，由空闲计时器决定何时退出）
    ensureToken: async () => {
      await renewTokenIfNeeded(region)
    },
    // 每次请求进来续命，避免空闲计时器误退正在使用的桌面端
    onActivity: () => { desktopSession.touch() },
  })
  return shim
}

/**
 * 周期性检查：到当天随机时刻且未签则领取。
 *
 * 若 token 过期/未登录且开启了自动拉起（MINIMAX_AUTO_LAUNCH=on，默认 on）：
 * 启动 MiniMax Code 桌面端 → 等其自动续期 → 签到 → 若由我们启动则退出桌面端。
 * 桌面端本来就在运行时只签到、不退出（尊重用户正在使用）。
 */
async function signinTick(): Promise<void> {
  for (const region of ['cn', 'en'] as MiniMaxRegion[]) {
    const rt = runtimes.get(region)
    if (!rt) continue
    // 自动拉起冷却：某区域今天拉起后仍拿不到 token（通常=该区域未登录），
    // 当天不再重复拉起，避免反复弹出桌面端。冷却按本地日期记录。
    const today = new Date().toISOString().slice(0, 10)
    if (launchCooldown.get(region) === today) continue
    // 静态预检：该区域连凭据文件都没有（从未登录）时，
    // 完全跳过——不进入 claimer、不 spawn 任何进程、不启动桌面端。
    if (AUTO_LAUNCH) {
      const has = await rt.store.hasCredential().catch(() => false)
      if (!has) {
        launchCooldown.set(region, today) // 无凭据当天也不必反复检查文件
        continue
      }
    }
    try {
      await rt.scheduler.runIfDue(region, async () => {
        return await ensureSigned(rt, false)
      })
    } catch {
      // 未登录/token 过期且未开启自动拉起：静默跳过
    }
  }
}

/** 区域 → 自动拉起失败冷却日期（YYYY-MM-DD），仅内存，重启后重置（可接受）。 */
const launchCooldown = new Map<MiniMaxRegion, string>()

/**
 * 保证某区域今天已签到。
 * @param manual 手动触发时，token 过期也允许拉起（忽略随机时间窗）
 */
async function ensureSigned(
  rt: RegionRuntime,
  manual: boolean,
): Promise<{ claimed: boolean; already: boolean; message: string }> {
  // 第一次：直接尝试（token 可能仍有效）
  try {
    const cred = await rt.store.resolve()
    return await rt.signin.claim(cred)
  } catch (firstError) {
    if (!AUTO_LAUNCH) {
      throw new Error(`token 不可用且未开启自动拉起：${firstError instanceof Error ? firstError.message : firstError}`)
    }
    // 关键区分：
    //  - signed-out（该区域从未登录/无凭据文件）：拉起桌面端也救不回来，
    //    桌面端只有一个、只续当前登录区的 token。绝不能为这种区域反复弹窗。
    //  - expired（有凭据但过期）：拉起桌面端可自动续期，才允许拉起。
    if (firstError instanceof MiniMaxAuthError && firstError.kind === 'signed-out') {
      if (!manual) launchCooldown.set(rt.region, new Date().toISOString().slice(0, 10))
      throw firstError
    }
    logger.warn(`minimax(${rt.region}): token 已过期，拉起桌面端续期……`)

    try {
      await renewTokenIfNeeded(rt.region)
    } catch (error) {
      // 拉起后仍无凭据：今天不再自动拉起，避免反复弹窗
      if (!manual) launchCooldown.set(rt.region, new Date().toISOString().slice(0, 10))
      throw error
    }

    // 续期成功后执行签到。签到是**一次性**任务，用完即还：
    // 若桌面端是代理本次拉起的，签完立刻退出（区别于请求驱动的续期——那需要留着给请求用）。
    try {
      const cred = await rt.store.resolve()
      const outcome = await rt.signin.claim(cred)
      return outcome
    } finally {
      if (desktopSession.owned) {
        // 给签到请求一点收尾时间，再退出并等待进程真正结束
        await new Promise(r => setTimeout(r, 1500))
        await terminateDesktop({ timeoutMs: QUIT_WAIT_MS }).catch(e =>
          logger.warn('退出桌面端失败：', String(e)))
        desktopSession.markStopped()
        logger.info(`minimax(${rt.region}): 签到流程结束，已退出由代理拉起的桌面端`)
      }
    }
  }
}

async function main(): Promise<void> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 })
  if (SIGNIN_ENABLED) await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  const shims: MiniMaxShim[] = []

  for (const region of ['cn', 'en'] as MiniMaxRegion[]) {
    const shim = await buildRegion(region)
    await shim.ready
    shims.push(shim)
    logger.info(`minimax(${region}) 已监听 ${shim.baseUrl()}`)
  }

  logger.info(`minimax-proxy 就绪：国内 ${REGION_PORTS.cn} / 国际 ${REGION_PORTS.en}`)

  // 接管上次由代理拉起的桌面端（若仍在运行）：
  // 否则代理重启即失忆，桌面端会永久残留 —— 正是「必须一直开着」的另一面。
  if (IDLE_EXIT_MS > 0) {
    const desktopRunning = await isRunning()
    const adopted = await desktopSession.restore(desktopRunning)
    if (adopted) {
      logger.info('minimax: 继续沿用空闲退出策略管理该桌面端')
    } else if (desktopRunning) {
      logger.info('minimax: 检测到桌面端在运行，但非代理拉起，不予接管（不会自动关闭它）')
    }
  }

  // 空闲退出：只针对「代理拉起的」桌面端；用户手动开的实例永不触碰。
  // 只要还有请求进来就会续命，因此长时间使用不会被打断。
  if (IDLE_EXIT_MS > 0) {
    const idleTimer = setInterval(() => { void desktopSession.tick() }, IDLE_TICK_MS)
    idleTimer.unref()
    logger.info(`空闲退出已启用：代理拉起的桌面端闲置 ${Math.round(IDLE_EXIT_MS / 60_000)} 分钟后自动关闭`)
  } else {
    logger.info('空闲退出已关闭（MINIMAX_IDLE_EXIT_MS=0）')
  }

  if (SIGNIN_ENABLED) {
    setTimeout(() => { void signinTick() }, SIGNIN_INITIAL_DELAY_MS).unref()
    const timer = setInterval(() => { void signinTick() }, SIGNIN_TICK_MS)
    timer.unref()
    logger.info(`每日签到已启用：本地 ${SIGNIN_START_HOUR}:00–${SIGNIN_END_HOUR}:00 随机时刻自动领取` +
      (AUTO_LAUNCH ? '；token 过期时自动拉起桌面端续期' : '；自动拉起桌面端已关闭'))
  } else {
    logger.info('每日签到已关闭（MINIMAX_SIGNIN=off）')
  }

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    logger.info(`收到 ${signal}，正在关闭...`)
    await Promise.allSettled(shims.map(shim => shim.close()))
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((error: unknown) => {
  logger.error('minimax-proxy 启动失败：', error)
  process.exit(1)
})
