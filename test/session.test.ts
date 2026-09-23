/**
 * 桌面端会话管理测试（纯逻辑，不触碰任何真实进程）。
 *
 * 覆盖：
 *  1. 只对「代理拉起」的实例负责 —— 未经 markStarted 的 tick 不动作
 *  2. 未到空闲阈值不退出
 *  3. 到阈值后退出，且清除归属
 *  4. touch() 续命后不再退出
 *  5. 退出未杀干净时保留归属、下个 tick 重试
 *  6. terminate 抛错时不崩溃、不误清归属
 *
 * 运行：node --test test/session.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DesktopSession } from '../src/session.ts'

/** 可手动推进的假时钟。 */
function fakeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => { t += ms },
  }
}

test('未 markStarted 的会话（用户手开的桌面端）永不退出', async () => {
  const clock = fakeClock()
  let terminated = 0
  const s = new DesktopSession({
    idleMs: 1000,
    now: clock.now,
    terminate: async () => { terminated++; return 0 },
  })
  clock.advance(10 * 60 * 1000)
  assert.equal(await s.tick(), false)
  assert.equal(terminated, 0, '不应触碰用户手开的桌面端')
  assert.equal(s.owned, false)
})

test('markStarted 后未到空闲阈值不退出', async () => {
  const clock = fakeClock()
  let terminated = 0
  const s = new DesktopSession({
    idleMs: 20 * 60 * 1000,
    now: clock.now,
    terminate: async () => { terminated++; return 0 },
  })
  s.markStarted()
  clock.advance(19 * 60 * 1000)
  assert.equal(await s.tick(), false)
  assert.equal(terminated, 0)
  assert.equal(s.owned, true)
})

test('到空闲阈值后退出并清除归属', async () => {
  const clock = fakeClock()
  let terminated = 0
  const logs: string[] = []
  const s = new DesktopSession({
    idleMs: 20 * 60 * 1000,
    now: clock.now,
    terminate: async () => { terminated++; return 0 },
    log: m => logs.push(m),
  })
  s.markStarted()
  clock.advance(20 * 60 * 1000 + 1)
  assert.equal(await s.tick(), true)
  assert.equal(terminated, 1)
  assert.equal(s.owned, false, '退出后应清除归属')
  assert.ok(logs.some(l => l.includes('空闲')), '应有日志')
})

test('touch() 续命：空闲被重置，不会退出', async () => {
  const clock = fakeClock()
  let terminated = 0
  const s = new DesktopSession({
    idleMs: 20 * 60 * 1000,
    now: clock.now,
    terminate: async () => { terminated++; return 0 },
  })
  s.markStarted()
  for (let i = 0; i < 5; i++) {
    clock.advance(15 * 60 * 1000)   // 每次前进 15 分钟
    s.touch()                        // 有请求进来 → 续命
    assert.equal(await s.tick(), false)
  }
  assert.equal(terminated, 0, '持续有请求时不应退出')
  assert.equal(s.owned, true)
})

test('退出未杀干净时保留归属，下个 tick 重试', async () => {
  const clock = fakeClock()
  let calls = 0
  const s = new DesktopSession({
    idleMs: 1000,
    now: clock.now,
    terminate: async () => { calls++; return calls === 1 ? 3 : 0 },  // 第一次还剩 3 个进程
  })
  s.markStarted()
  clock.advance(2000)
  assert.equal(await s.tick(), true)
  assert.equal(s.owned, true, '未杀干净应保留归属以便重试')
  assert.equal(await s.tick(), true)
  assert.equal(s.owned, false, '第二次杀干净后清除归属')
})

test('terminate 抛错时不崩溃，且不误清归属', async () => {
  const clock = fakeClock()
  const s = new DesktopSession({
    idleMs: 1000,
    now: clock.now,
    terminate: async () => { throw new Error('taskkill 失败') },
    log: () => {},
  })
  s.markStarted()
  clock.advance(2000)
  assert.equal(await s.tick(), true, '应报告尝试过')
  assert.equal(s.owned, true, '失败后仍保留归属')
})

test('markStopped 后不再跟踪', async () => {
  const clock = fakeClock()
  let terminated = 0
  const s = new DesktopSession({
    idleMs: 1000,
    now: clock.now,
    terminate: async () => { terminated++; return 0 },
  })
  s.markStarted()
  s.markStopped()
  clock.advance(10 * 60 * 1000)
  assert.equal(await s.tick(), false)
  assert.equal(terminated, 0)
})

test('idleForMs 在从未活动时为 0', () => {
  const clock = fakeClock()
  const s = new DesktopSession({ now: clock.now, terminate: async () => 0 })
  assert.equal(s.idleForMs(), 0)
  clock.advance(999999)
  assert.equal(s.idleForMs(), 0, '未 markStarted 时不应计为长时间空闲')
})

// ---------- ownership 持久化 ----------

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mm-session-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('持久化：代理重启后能接管自己拉起的桌面端', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'ownership.json')
    const clock = fakeClock()

    // 第一个实例拉起桌面端
    const a = new DesktopSession({ idleMs: 20 * 60 * 1000, now: clock.now, stateFile: file, terminate: async () => 0 })
    a.markStarted()
    await new Promise(r => setTimeout(r, 20))   // 等落盘

    // 代理重启：新实例从磁盘恢复
    clock.advance(60 * 1000)
    const b = new DesktopSession({ idleMs: 20 * 60 * 1000, now: clock.now, stateFile: file, terminate: async () => 0 })
    const adopted = await b.restore(true)
    assert.equal(adopted, true, '应接管')
    assert.equal(b.owned, true)
    assert.ok(b.idleForMs() >= 60 * 1000, '应沿用上次活动时间，而不是从 0 重新计时')
  })
})

test('持久化：桌面端已不在运行时 restore 不接管', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'ownership.json')
    const a = new DesktopSession({ stateFile: file, terminate: async () => 0 })
    a.markStarted()
    await new Promise(r => setTimeout(r, 20))

    const b = new DesktopSession({ stateFile: file, terminate: async () => 0 })
    assert.equal(await b.restore(false), false, '桌面端不在运行则不应接管')
    assert.equal(b.owned, false)
  })
})

test('持久化：未 markStarted 的实例不会写入 ownership', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'ownership.json')
    const b = new DesktopSession({ stateFile: file, terminate: async () => 0 })
    assert.equal(await b.restore(true), false, '无记录时不应接管')
    assert.equal(b.owned, false)
  })
})

test('持久化：退出后清空记录，再重启不会误接管', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'ownership.json')
    const clock = fakeClock()
    const a = new DesktopSession({ idleMs: 1000, now: clock.now, stateFile: file, terminate: async () => 0 })
    a.markStarted()
    clock.advance(2000)
    await a.tick()
    assert.equal(a.owned, false)
    await new Promise(r => setTimeout(r, 20))

    const b = new DesktopSession({ idleMs: 1000, now: clock.now, stateFile: file, terminate: async () => 0 })
    assert.equal(await b.restore(true), false, '已退出过的记录不应再次接管')
  })
})
