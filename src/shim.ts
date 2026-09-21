/**
 * 回环 Anthropic 兼容端点（MiniMax 版）。
 *
 * 与 workbuddy/trae shim 同样的四重回环安全校验（Host/Origin/JSON/bearer 常量时间比对）、
 * body 上限、错误到 HTTP 状态码映射；新增对 `x-api-key` 的支持（@ai-sdk/anthropic 默认用它）。
 * 协议层为 Anthropic Messages 透传，不做格式转换。
 *
 * @module minimax-proxy/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import { LiveMiniMaxStore, MiniMaxAuthError, type MiniMaxRegion } from './auth.ts'
import { MiniMaxCatalog } from './catalog.ts'
import { MiniMaxUpstreamClient, type UpstreamErrorKind } from './upstream.ts'
import { MINIMAX_CONNECT_VERSION } from './version.ts'
import { redactPaths } from './redact.ts'

export interface ShimLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface MiniMaxShim {
  ready: Promise<void>
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

export interface MiniMaxShimOptions {
  region: MiniMaxRegion
  port: number
  host?: string
  token?: string
  store: LiveMiniMaxStore
  client: MiniMaxUpstreamClient
  catalog: MiniMaxCatalog
  logger?: ShimLogger
  /** 只读签到面板（含今日计划）；不提供则 /signin/* 返回 404 */
  signinStatus?: () => Promise<unknown>
  /** 立即检查/领取今日签到（幂等） */
  signinClaim?: () => Promise<unknown>
}

const BODY_LIMIT = 64 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const STATUS_BY_KIND: Readonly<Record<UpstreamErrorKind, number>> = {
  authentication: 401,
  rate_limit: 429,
  client: 400,
  server: 502,
  network: 502,
}

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

function hostIsLoopback(host: string | undefined): boolean {
  return host !== undefined && host.trim() !== '' && LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const hostname = new URL(origin).hostname
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeError(res: ServerResponse, status: number, kind: string, message: string): void {
  // 错误体也用 Anthropic 风格，方便 SDK 解析；
  // 消息统一脱敏本机路径，避免日志/界面泄露真实用户名与目录。
  writeJson(res, status, { type: 'error', error: { type: kind, message: redactPaths(message) } })
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 同时接受 Authorization: Bearer 与 x-api-key（anthropic SDK 默认）。 */
function constantTimeMatch(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createMiniMaxShim(options: MiniMaxShimOptions): MiniMaxShim {
  const secret = options.token ?? randomBytes(32).toString('base64url')
  const region = options.region
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => { void handle(req, res) })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const host = options.host ?? '127.0.0.1'
  server.listen(options.port, host)

  function secretFromRequest(req: IncomingMessage): string | null {
    const auth = req.headers.authorization
    if (typeof auth === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
      if (m !== null) return m[1] ?? null
    }
    const xkey = req.headers['x-api-key']
    if (typeof xkey === 'string' && xkey.trim() !== '') return xkey.trim()
    return null
  }

  function authed(req: IncomingMessage): boolean {
    const provided = secretFromRequest(req)
    return provided !== null && constantTimeMatch(provided, secret)
  }

  async function status(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await options.store.status()
    writeJson(res, 200, { region, auth, models: options.catalog.current().map(m => m.id) })
  }

  function listModels(res: ServerResponse): void {
    // Anthropic /v1/models 风格
    const data = options.catalog.current().map(m => ({
      type: 'model',
      id: m.id,
      display_name: m.name,
      created_at: '2026-01-01T00:00:00Z',
    }))
    writeJson(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) return writeError(res, 403, 'forbidden', 'Host must be loopback')
      if (!originIsLoopback(req.headers.origin)) return writeError(res, 403, 'forbidden', 'Origin must be loopback')
      if (!authed(req)) return writeError(res, 401, 'authentication_error', 'Missing or invalid API key')

      const url = req.url ?? '/'

      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true, region, version: MINIMAX_CONNECT_VERSION })
      }
      if (req.method === 'GET' && (url === '/status' || url === '/status/')) {
        return await status(req, res)
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/' || url === '/models' || url === '/models/')) {
        return listModels(res)
      }

      // ===== 每日签到 =====
      if (url.split('?')[0] === '/signin/status') {
        if (req.method === 'GET') {
          if (!options.signinStatus) return writeError(res, 404, 'not_found_error', 'sign-in not available')
          try {
            return writeJson(res, 200, await options.signinStatus())
          } catch (error) {
            return writeError(res, 502, 'api_error', error instanceof Error ? error.message : 'sign-in status failed')
          }
        }
      }
      if (url.split('?')[0] === '/signin/claim') {
        if (req.method === 'POST') {
          if (!options.signinClaim) return writeError(res, 404, 'not_found_error', 'sign-in not available')
          try {
            return writeJson(res, 200, await options.signinClaim())
          } catch (error) {
            return writeError(res, 502, 'api_error', error instanceof Error ? error.message : 'sign-in claim failed')
          }
        }
      }

      // Anthropic Messages：兼容 /v1/messages 与 /messages（@ai-sdk/anthropic
      // 的 baseURL 若不含 /v1 前缀，SDK 会发到 /messages 而非 /v1/messages）
      const messagesMatch = /^\/(?:v1\/)?messages(\/count_tokens)?\/?$/.exec(url.split('?')[0] ?? '')
      if (req.method === 'POST' && messagesMatch !== null) {
        const ct = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : ''
        if (!ct.startsWith('application/json')) {
          return writeError(res, 415, 'invalid_request_error', 'Content-Type must be application/json')
        }
        const raw = (await readBody(req)).toString('utf8')
        let parsed: { model?: unknown }
        try {
          parsed = JSON.parse(raw)
        } catch {
          return writeError(res, 400, 'invalid_request_error', 'Request body must be valid JSON')
        }
        if (typeof parsed.model !== 'string' || parsed.model === '') {
          return writeError(res, 400, 'invalid_request_error', 'Missing required field: model')
        }
        if (!options.catalog.has(parsed.model)) {
          return writeError(res, 404, 'not_found_error', `Unknown model: ${parsed.model}`)
        }

        let cred
        try {
          cred = await options.store.resolve()
        } catch (error) {
          if (error instanceof MiniMaxAuthError) {
            const code = error.kind === 'expired' ? 401 : 503
            const type = error.kind === 'expired' ? 'authentication_error' : 'unavailable_error'
            return writeError(res, code, type, error.message)
          }
          throw error
        }

        const controller = new AbortController()
        const abort = (): void => controller.abort()
        req.once('aborted', abort)
        req.socket.once('close', abort)

        const subPath = messagesMatch[1] !== undefined ? '/messages/count_tokens' : '/messages'
        const result = await options.client.send(cred, subPath, raw, req.headers, controller.signal)
        if (!result.ok || !result.response) {
          const code = result.kind ? STATUS_BY_KIND[result.kind] : 502
          return writeError(res, code, 'api_error', result.message ?? 'upstream error')
        }

        const up = result.response
        const respHeaders: Record<string, string> = {
          'content-type': up.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-cache',
        }
        for (const h of ['anthropic-organization-id', 'request-id', 'anthropic-ratelimit-requests-limit']) {
          const v = up.headers.get(h)
          if (v !== null) respHeaders[h] = v
        }
        res.writeHead(up.status, respHeaders)
        const body = Readable.fromWeb(up.body as Parameters<typeof Readable.fromWeb>[0])
        body.on('error', (error: unknown) => {
          options.logger?.warn(`minimax(${region}): upstream stream failed`, error)
          if (!res.writableEnded) res.end()
        })
        body.pipe(res)
        return
      }

      writeError(res, 404, 'not_found_error', `No such route: ${req.method} ${url}`)
    } catch (error) {
      options.logger?.error(`minimax(${region}): shim request failed`, error)
      if (!res.headersSent) writeError(res, 500, 'api_error', 'Internal shim error')
      else if (!res.writableEnded) res.end()
    }
  }

  return {
    ready,
    baseUrl: () => `http://${host}:${options.port}`,
    token: () => secret,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      server.close(error => error === undefined ? resolve() : reject(error))
    }),
  }
}
