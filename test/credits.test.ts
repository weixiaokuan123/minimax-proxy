import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCreditDetails, creditsExpiringWithinMs, DAY_MS, type MiniMaxCredits } from '../src/credits.ts'

/**
 * MiniMax 积分明细解析。
 *
 * 上游是 `GET /minimax-cloud/api/v1/credit/details`，返回 `details[]`，每笔形如：
 *
 *   { granted_at_ms, expire_at_ms, credit_type,
 *     granted_amount: "800.00", remaining_amount: "800.00", consumed_amount: "0.00" }
 *
 * 三个容易踩的点，这里都钉住：
 *   1. **金额是字符串**（"800.00"），不是数字——直接当 number 用会得到 NaN；
 *   2. **用完的额度仍在列表里**（实测 13 笔里 8 笔 remaining=0），不剔掉就等于
 *      13 个包里有 8 个是 0，聚合出来一堆空行；
 *   3. 形状必须和 workbuddy 的包同构，面板才能**复用同一个** groupCreditPackages()。
 */

const NOW = Date.parse('2026-09-29T12:00:00Z')

/** 造一笔上游记录 */
const item = (o: {
  granted?: string
  remain?: string
  consumed?: string
  expireInDays?: number
  grantedDaysAgo?: number
}) => ({
  granted_at_ms: NOW - (o.grantedDaysAgo ?? 0) * DAY_MS,
  expire_at_ms: NOW + (o.expireInDays ?? 10) * DAY_MS,
  credit_type: 2,
  granted_amount: o.granted ?? '400.00',
  remaining_amount: o.remain ?? '0.00',
  consumed_amount: o.consumed ?? '0.00',
})

const wrap = (details: unknown[]) => ({ details, total_count: details.length, base_resp: { status_code: 0, status_msg: 'ok' } })

// ---------- 金额是字符串 ----------

test('金额是字符串，必须 parseFloat 而不能当数字用', () => {
  const c = parseCreditDetails(wrap([item({ remain: '800.00' })]), NOW)
  assert.equal(c.packages[0]?.remain, 800, '"800.00" 必须变成 800')
  assert.equal(Number.isNaN(c.total), false, 'total 不能是 NaN')
  assert.equal(c.total, 800)
})

test('带小数点的金额要保留精度', () => {
  const c = parseCreditDetails(wrap([item({ remain: '123.45', granted: '200.00' })]), NOW)
  assert.equal(c.packages[0]?.remain, 123.45)
  assert.equal(c.packages[0]?.size, 200)
})

// ---------- 丢弃用完的 ----------

test('remaining=0 的记录必须剔除', () => {
  // 实测 13 笔里 8 笔已用完；不剔就等于面板上多出 8 个空的到期组
  const c = parseCreditDetails(wrap([
    item({ remain: '800.00' }),
    item({ remain: '0.00', consumed: '400.00' }),
    item({ remain: '0.00', consumed: '1000.00' }),
  ]), NOW)
  assert.equal(c.packages.length, 1, `应只剩 1 笔，实际 ${c.packages.length}`)
  assert.equal(c.total, 800, 'total 只算还有余额的')
})

// ---------- 汇总字段 ----------

test('total / expiringSoon / nearestExpiryMs 要算对', () => {
  const c = parseCreditDetails(wrap([
    item({ remain: '400.00', expireInDays: 2 }),
    item({ remain: '1000.00', expireInDays: 5 }),
    item({ remain: '800.00', expireInDays: 25 }),
  ]), NOW)
  assert.equal(c.total, 2200)
  assert.equal(c.expiringSoon, 1400, '7 天内到期的是前两笔：400+1000')
  assert.equal(c.nearestExpiryMs, NOW + 2 * DAY_MS, '最近到期是 2 天后那笔')
})

test('全部为空时 total=0、nearestExpiryMs=undefined', () => {
  const c = parseCreditDetails(wrap([item({ remain: '0.00' })]), NOW)
  assert.equal(c.total, 0)
  assert.equal(c.nearestExpiryMs, undefined)
  assert.equal(c.packages.length, 0)
})

// ---------- 形状与 workbuddy 同构（面板复用全靠这个） ----------

test('每笔的字段名必须与 workbuddy 的包一致', () => {
  const c = parseCreditDetails(wrap([item({ remain: '400.00', granted: '400.00' })]), NOW)
  const p = c.packages[0]!
  // 面板的 groupCreditPackages() 读的就是这几个名字，少一个就地崩
  assert.equal(typeof p.remain, 'number')
  assert.equal(typeof p.size, 'number')
  assert.equal(typeof p.expiresAtMs, 'number')
  assert.equal(p.monthly, false, 'minimax 没有月度包，但字段必须存在以免面板判 undefined')
  assert.equal(p.consumed, 0)
})

// ---------- 脏数据 ----------

test('上游给了怪东西不能把面板带崩', () => {
  for (const bad of [null, undefined, 0, 'x', {}, [1, 2]]) {
    const c = parseCreditDetails(wrap([bad, item({ remain: '100.00' })]), NOW)
    assert.equal(c.total, 100, `脏数据 ${JSON.stringify(bad)} 之后仍应能算对`)
  }
})

test('整个响应不是预期形状时降级成空，而不是抛异常', () => {
  assert.equal(parseCreditDetails(null, NOW).total, 0)
  assert.equal(parseCreditDetails({}, NOW).total, 0)
  assert.equal(parseCreditDetails({ details: 'x' }, NOW).total, 0)
  assert.equal(parseCreditDetails({ details: { nope: 1 } }, NOW).total, 0)
})

test('负数余额按 0 处理（上游给负数不该让面板显示负分）', () => {
  const c = parseCreditDetails(wrap([item({ remain: '-50.00' })]), NOW)
  assert.equal(c.total, 0)
})

// ---------- 提醒阈值 ----------

test('提醒窗口：7 天内到期才算，过期的不算', () => {
  const c = parseCreditDetails(wrap([
    item({ remain: '400.00', expireInDays: 3 }),
    item({ remain: '100.00', expireInDays: 30 }),
  ]), NOW)
  const in7 = creditsExpiringWithinMs(c, NOW, 7 * DAY_MS)
  assert.equal(in7.amount, 400, '只有 3 天后那笔进提醒')
  assert.equal(in7.count, 1)
})

test('刚好 7 天整要算在内（边界别搞反）', () => {
  const c = parseCreditDetails(wrap([item({ remain: '400.00', expireInDays: 7 })]), NOW)
  assert.equal(creditsExpiringWithinMs(c, NOW, 7 * DAY_MS).amount, 400)
})

test('已经过期的额度不产生提醒（否则每天都有一条僵尸提醒）', () => {
  const c = parseCreditDetails(wrap([item({ remain: '400.00', expireInDays: -2 })]), NOW)
  const r = creditsExpiringWithinMs(c, NOW, 7 * DAY_MS)
  assert.equal(r.amount, 0, '过期的不该提醒')
  assert.equal(r.count, 0)
})

test('没有任何额度时不产生提醒', () => {
  const c = parseCreditDetails(wrap([]), NOW)
  assert.equal(creditsExpiringWithinMs(c, NOW, 7 * DAY_MS).amount, 0)
})

// ---------- 常量 ----------

test('DAY_MS 是一天的毫秒数', () => {
  assert.equal(DAY_MS, 24 * 60 * 60 * 1000)
})
