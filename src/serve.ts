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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveMiniMaxStore, MiniMaxAuthError, type MiniMaxRegion } from './auth.ts'
import { MiniMaxCatalog } from './catalog.ts'
import { createMiniMaxShim, type MiniMaxShim, type ShimLogger } from './shim.ts'
import { MiniMaxUpstreamClient } from './upstream.ts'
import { MiniMaxSigninClient } from './signin.ts'
import { SigninScheduler, formatSec } from './scheduler.ts'
import { launchDesktop, terminateDesktop, waitForTokenReady } from './launcher.ts'

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

const REGION_PORTS: Record<MiniMaxRegion, number> = {
  cn: Number(process.env['MINIMAX_CN_PORT'] ?? 39305),
  en: Number(process.env['MINIMAX_EN_PORT'] ?? 39306),
}

function ts(): string {
  return new Date().toISOString()
}

const logger: ShimLogger = {
  info: (...args) => process.stdout.write(`[${ts()}] [info] ${args.map(String).join(' ')}\n`),
  warn: (...args) => process.stderr.write(`[${ts()}] [warn] ${args.map(String).join(' ')}\n`),
  error: (...args) => process.stderr.write(`[${ts()}] [error] ${args.map(String).join(' ')}\n`),
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

async function buildRegion(region: MiniMaxRegion): Promise<MiniMaxShim> {
  const store = new LiveMiniMaxStore(region)
  const client = new MiniMaxUpstreamClient(region)
  const catalog = new MiniMaxCatalog(region)
  const signin = new MiniMaxSigninClient(region)
  const scheduler = new SigninScheduler({
    stateFile: join(STATE_DIR, 'signin-state.json'),
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

    // 拉起前先确认桌面端没在运行（在运行却仍 expired 的情况交给用户，不重复拉）
    const launch = await launchDesktop()
    if (launch.error) throw new Error(launch.error)
    if (launch.wasAlreadyRunning) {
      // 桌面端已在运行但此区 token 仍不可用：通常=它登录的是另一区域，
      // 等待一次续期；仍失败则当天冷却，不反复尝试。
      logger.warn(`minimax(${rt.region}): 桌面端已在运行，等待其续期……`)
    }

    // 等桌面端自动续期写盘（store.resolve 成功即就绪）
    const ready = await waitForTokenReady({
      timeoutMs: LAUNCH_WAIT_MS,
      check: async () => {
        try { await rt.store.resolve(); return true } catch { return false }
      },
    })
    if (!ready) {
      if (launch.startedByUs) await terminateDesktop().catch(() => {})
      // 该区域拉起后仍无 token（多半是未登录此区域）：今天不再自动拉起，避免反复弹窗
      if (!manual) launchCooldown.set(rt.region, new Date().toISOString().slice(0, 10))
      throw new Error('桌面端启动后未能在限定时间内续期 token（该区域可能未登录）')
    }

    // 续期成功后执行签到。无论签到成功还是抛错，只要桌面端是代理本次拉起的，
    // 都必须在 finally 里退出——避免签到失败导致桌面端残留运行。
    try {
      const cred = await rt.store.resolve()
      const outcome = await rt.signin.claim(cred)
      return outcome
    } finally {
      if (launch.startedByUs) {
        // 给签到请求一点收尾时间，再退出并等待进程真正结束
        await new Promise(r => setTimeout(r, 1500))
        await terminateDesktop({ timeoutMs: QUIT_WAIT_MS }).catch(e =>
          logger.warn('退出桌面端失败：', String(e)))
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

  if (SIGNIN_ENABLED) {
    setTimeout(() => { void signinTick() }, SIGNIN_INITIAL_DELAY_MS).unref()
    const timer = setInterval(() => { void signinTick() }, SIGNIN_TICK_MS)
    timer.unref()
    logger.info(`每日签到已启用：本地 ${SIGNIN_START_HOUR}:00–${SIGNIN_END_HOUR}:00 随机时刻自动领取` +
      (AUTO_LAUNCH ? '；token 过期时自动拉起桌面端、签完退出' : '；自动拉起桌面端已关闭'))
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
