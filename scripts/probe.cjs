const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const key = fs.readFileSync(path.join(root, 'keys', 'cn.key'), 'utf8').trim()
const base = 'http://127.0.0.1:39305'

async function main() {
  console.log('== healthz ==')
  console.log(await (await fetch(`${base}/healthz`, { headers: { 'x-api-key': key } })).text())

  console.log('== status ==')
  const st = await (await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${key}` } })).json()
  const safe = { ...st, auth: { ...st.auth, filePath: st.auth.filePath ? st.auth.filePath.replace(/\\/g, '/').split('/').slice(-4).join('/') : undefined } }
  console.log(JSON.stringify(safe, null, 2))

  console.log('== models ==')
  const ml = await (await fetch(`${base}/v1/models`, { headers: { 'x-api-key': key } })).json()
  console.log(ml.data.map(m => m.id).join(', '))

  console.log('\n== 非流式 messages（x-api-key 鉴权）==')
  let r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'MiniMax-M3', max_tokens: 32, messages: [{ role: 'user', content: 'Reply with exactly: hi' }] }),
  })
  console.log('HTTP', r.status, (await r.text()).slice(0, 220))

  console.log('\n== 流式工具调用（Bearer 鉴权）==')
  r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'MiniMax-M3', max_tokens: 200, stream: true,
      tools: [{ name: 'get_weather', description: 'Get weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      messages: [{ role: 'user', content: 'Weather in Paris? Use the tool.' }],
    }),
  })
  console.log('HTTP', r.status, r.headers.get('content-type'))
  const text = await r.text()
  const types = []
  let tool = [], stop = null
  for (const ev of text.split('\n\n')) {
    for (const line of ev.split('\n')) {
      if (!line.startsWith('data:')) continue
      let d; try { d = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (d.type) types.push(d.type)
      if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') tool.push('TOOL ' + d.content_block.name)
      if (d.delta?.partial_json) tool.push(d.delta.partial_json)
      if (d.delta?.stop_reason) stop = d.delta.stop_reason
    }
  }
  console.log('事件:', [...new Set(types)].join(', '))
  console.log('工具:', tool.join(' | ').slice(0, 160))
  console.log('stop:', stop)

  console.log('\n== 鉴权失败用例（错误 key 应 401）==')
  r = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'wrong-key', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'MiniMax-M3', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  })
  console.log('HTTP', r.status, (await r.text()).slice(0, 120))
}
main().catch(e => { console.error(e); process.exit(1) })
