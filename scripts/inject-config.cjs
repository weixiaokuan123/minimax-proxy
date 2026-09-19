const fs = require('node:fs')
const path = require('node:path')

const cfgPath = path.join(__dirname, '..', '..', 'opencode.jsonc')
let raw = fs.readFileSync(cfgPath, 'utf8')

// 去掉 JSONC 注释（行注释 // 与块注释），简单处理以能解析
const strip = (s) => {
  let out = ''
  let i = 0
  let inStr = false
  let quote = ''
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === quote) inStr = false
      i++
      continue
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue }
    out += c
    i++
  }
  return out
}

const cfg = JSON.parse(strip(raw))
cfg.provider = cfg.provider || {}

const root = path.join(__dirname, '..')
const keyFile = (f) => '{file:' + path.join(root, 'keys', f).replace(/\\/g, '/') + '}'

const limit = (context, output) => ({ context, output })
const textOnly = () => ({ modalities: { input: ['text'], output: ['text'] } })
const textAndImage = () => ({ modalities: { input: ['text', 'image'], output: ['text'] } })

const cnModels = {
  'MiniMax-M3': { name: 'MiniMax-M3 (代理国内)', limit: limit(512000, 128000), ...textAndImage(), options: { reasoningEffort: 'auto' } },
  'MiniMax-M2.7': { name: 'MiniMax-M2.7 (代理国内)', limit: limit(200000, 128000), ...textOnly() },
  'MiniMax-M2.7-highspeed': { name: 'MiniMax-M2.7-HighSpeed (代理国内)', limit: limit(200000, 128000), ...textOnly() },
}

// 国内版：本机回环 Anthropic 兼容端点（只读 MiniMax Code 桌面端登录态）
cfg.provider['minimax-cn'] = {
  npm: '@ai-sdk/anthropic',
  name: 'MiniMax 国内版(代理)',
  options: {
    baseURL: 'http://127.0.0.1:39305',
    apiKey: keyFile('cn.key'),
  },
  models: cnModels,
}

// 国际版：登录国际版 MiniMax Code 后自动可用
cfg.provider['minimax-en'] = {
  npm: '@ai-sdk/anthropic',
  name: 'MiniMax 国际版(代理)',
  options: {
    baseURL: 'http://127.0.0.1:39306',
    apiKey: keyFile('en.key'),
  },
  models: {
    'MiniMax-M3': { name: 'MiniMax-M3 (代理国际)', limit: limit(512000, 128000), ...textAndImage() },
    'MiniMax-M2.7': { name: 'MiniMax-M2.7 (代理国际)', limit: limit(200000, 128000), ...textOnly() },
    'MiniMax-M2.7-highspeed': { name: 'MiniMax-M2.7-HighSpeed (代理国际)', limit: limit(200000, 128000), ...textOnly() },
  },
}

fs.copyFileSync(cfgPath, cfgPath + '.bak.minimax')
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
console.log('minimax providers injected; backup at opencode.jsonc.bak.minimax')
