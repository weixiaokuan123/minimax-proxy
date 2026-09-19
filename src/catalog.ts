/**
 * 静态模型目录。MiniMax Code 的模型由其 mavis 通道维护，数量少且稳定，
 * 这里按官方配置（MiniMax-M3 / M2.7 / M2.7-highspeed）固化，避免额外的目录请求。
 *
 * @module minimax-proxy/catalog
 */

import type { MiniMaxRegion } from './auth.ts'

export interface CatalogModel {
  id: string
  name: string
  context: number
  output: number
  reasoning: boolean
  vision: boolean
}

const CN_MODELS: CatalogModel[] = [
  { id: 'MiniMax-M3', name: 'MiniMax-M3', context: 512000, output: 128000, reasoning: true, vision: true },
  { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', context: 200000, output: 128000, reasoning: true, vision: false },
  { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-HighSpeed', context: 200000, output: 128000, reasoning: true, vision: false },
]

// 国际版通道当前同样提供这几个模型；如官方调整，以后可改为启动时拉取。
const EN_MODELS: CatalogModel[] = CN_MODELS

export class MiniMaxCatalog {
  readonly models: CatalogModel[]
  readonly region: MiniMaxRegion

  constructor(region: MiniMaxRegion) {
    this.region = region
    this.models = region === 'cn' ? CN_MODELS : EN_MODELS
  }

  current(): CatalogModel[] {
    return this.models
  }

  has(id: string): boolean {
    return this.models.some(m => m.id === id)
  }
}
