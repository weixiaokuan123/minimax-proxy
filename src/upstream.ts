/**
 * 上游 Anthropic 兼容透传客户端。
 *
 * MiniMax Code 的 mavis LLM 网关原生就是 Anthropic Messages 协议，
 * 因此无需任何请求/响应格式转换：原样转发 body 与 SSE 流即可。
 *
 * @module minimax-proxy/upstream
 */

import type { MiniMaxCredential, MiniMaxRegion, RegionEndpoint } from './auth.ts'
import { REGIONS } from './auth.ts'

export interface UpstreamResult {
  ok: boolean
  status?: number
  response?: Response
  kind?: UpstreamErrorKind
  message?: string
}

export type UpstreamErrorKind = 'authentication' | 'rate_limit' | 'client' | 'server' | 'network'

export class MiniMaxUpstreamClient {
  private readonly region: MiniMaxRegion
  constructor(region: MiniMaxRegion) {
    this.region = region
  }

  private get endpoint(): RegionEndpoint {
    return REGIONS[this.region]
  }

  /**
   * 透传一次 Messages（或 messages/count_tokens）请求。
   * @param subPath 例如 '/messages'、'/messages/count_tokens'
   * @param body 已校验为 JSON 的原始字符串（原样转发，保留 anthropic 全部字段）
   * @param incomingHeaders 来自 opencode 的请求头（透传 anthropic-version/beta 等）
   */
  async send(
    cred: MiniMaxCredential,
    subPath: string,
    body: string,
    incomingHeaders: Record<string, string | string[] | undefined>,
    signal: AbortSignal,
  ): Promise<UpstreamResult> {
    const url = this.endpoint.messagesBaseUrl + subPath
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // 上游只认 Bearer（已实测 x-api-key 会 401）
      'authorization': `Bearer ${cred.accessToken}`,
    }
    // 透传 anthropic 相关协商头；剔除 hop-by-hop 与本地鉴权头
    const passthrough = ['anthropic-version', 'anthropic-beta', 'accept']
    for (const name of passthrough) {
      const v = incomingHeaders[name]
      if (typeof v === 'string' && v.trim() !== '') headers[name] = v
    }
    if (headers['anthropic-version'] === undefined) headers['anthropic-version'] = '2023-06-01'

    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers, body, signal })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      return { ok: false, kind: 'network', message: `上游连接失败：${String((error as Error)?.message ?? error)}` }
    }

    if (response.ok) return { ok: true, status: response.status, response }

    const text = await response.text().catch(() => '')
    const kind: UpstreamErrorKind =
      response.status === 401 || response.status === 403 ? 'authentication'
        : response.status === 429 ? 'rate_limit'
          : response.status >= 500 ? 'server'
            : 'client'
    return { ok: false, kind, status: response.status, message: text.slice(0, 800) || `上游 HTTP ${response.status}` }
  }
}
