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
import { LiveMiniMaxStore, type MiniMaxRegion } from './auth.ts'
import { MiniMaxCatalog } from './catalog.ts'
import { createMiniMaxShim, type MiniMaxShim, type ShimLogger } from './shim.ts'
import { MiniMaxUpstreamClient } from './upstream.ts'
import { MiniMaxSigninClient } from './signin.ts'
import { SigninScheduler, formatSec } from './scheduler.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const KEYS_DIR = join(ROOT, 'keys')
const STATE_DIR = join(ROOT, 'state')

const SIGNIN_ENABLED = (process.env['MINIMAX_SIGNIN'] ?? 'on') !== 'off'
const SIGNIN_START_HOUR = Number(process.env['MINIMAX_SIGNIN_START_HOUR'] ?? 7)
const SIGNIN_END_HOUR = Number(process.env['MINIMAX_SIGNIN_END_HOUR'] ?? 10)
const SIGNIN_TICK_MS = 5 * 60 * 1000
const SIGNIN_INITIAL_DELAY_MS = 60 * 1000

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
      const cred = await store.resolve()
      const outcome = await scheduler.runNow(region, async () => {
        const r = await signin.claim(cred)
        return { claimed: r.claimed, already: r.already, message: r.message }
      })
      return { region, ...outcome }
    },
  })
  return shim
}

/** 周期性检查：到当天随机时刻且未签则领取。未登录/过期静默跳过。 */
async function signinTick(): Promise<void> {
  for (const region of ['cn', 'en'] as MiniMaxRegion[]) {
    const rt = runtimes.get(region)
    if (!rt) continue
    try {
      await rt.scheduler.runIfDue(region, async () => {
        const cred = await rt.store.resolve()
        const r = await rt.signin.claim(cred)
        return { claimed: r.claimed, already: r.already, message: r.message }
      })
    } catch {
      // 未登录/token 过期：本轮静默跳过，不刷屏
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
    logger.info(`每日签到已启用：本地 ${SIGNIN_START_HOUR}:00–${SIGNIN_END_HOUR}:00 随机时刻自动领取`)
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
