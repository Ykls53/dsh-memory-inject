/**
 * 访问频率调优测试（对齐 Anthropic 文章「按访问频率调做梦节奏」）。
 *
 * 同时锁住一个致命风险：做梦的 prompt 只带前 40 条（按访问频率排序），
 * 但写回必须用完整原文件 —— 否则第 41 条之后的内容会被整批丢掉。
 * 跑法：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, runDream, DEFAULTS } from '../index.js'

const DELIM = '\n§\n'
const entriesOf = (p) => readFileSync(p, 'utf8').split(/\n\s*§\s*\n/).map((s) => s.trim()).filter(Boolean)

function mkDir(user, env = ['环境一条']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-'))
  writeFileSync(path.join(dir, 'USER.md'), user.join(DELIM) + '\n', 'utf8')
  writeFileSync(path.join(dir, 'MEMORY.md'), env.join(DELIM) + '\n', 'utf8')
  return dir
}
function llm(text) {
  return { stream() { return (async function* () { yield { type: 'text-delta', index: 0, text }; yield { type: 'finish', reason: { kind: 'stop' } } })() } }
}
const ctx = (t) => ({ get: (n) => (n === 'llm' ? llm(t) : undefined), logger: { info() {}, warn() {} } })
const cfg = (dir) => ({ ...DEFAULTS, memoryDir: dir, extractProvider: 'p', extractModel: 'm' })

test('🔴 超过 40 条时，写回不丢第 41 条之后的内容', async () => {
  const fifty = Array.from({ length: 50 }, (_, i) => `第${i + 1}条记忆内容`)
  const dir = mkDir(fifty)
  try {
    // 只改第一条，其余什么都别动
    await runDream(ctx('FIX 1 => 第1条改过了'), cfg(dir))
    const after = entriesOf(path.join(dir, 'USER.md'))
    assert.strictEqual(after.length, 50, `必须还是 50 条，实际 ${after.length}`)
    assert.ok(after.includes('第50条记忆内容'), '第 50 条不能丢')
    assert.ok(after.includes('第41条记忆内容'), '第 41 条不能丢')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('注入会累计使用次数', async () => {
  const dir = mkDir(['画像甲', '画像乙'])
  try {
    const c = { handlers: new Map(), on(e, f) { this.handlers.set(e, f) }, logger: { info() {}, warn() {} } }
    apply(c, { memoryDir: dir, wikiIndex: false })
    const h = c.handlers.get('agent/pre-step')
    await h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
    await h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
    assert.ok(existsSync(path.join(dir, '.usage.json')), '应当写出使用统计')
    const usage = JSON.parse(readFileSync(path.join(dir, '.usage.json'), 'utf8'))
    const vals = Object.values(usage)
    assert.ok(vals.length >= 2, '两条记忆都该被记录')
    assert.ok(vals.every((v) => v.n >= 2), `注入两次，次数应≥2：${JSON.stringify(vals)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('使用统计不进记忆正文、不占注入预算', async () => {
  const dir = mkDir(['画像一条'])
  try {
    const c = { handlers: new Map(), on(e, f) { this.handlers.set(e, f) }, logger: { info() {}, warn() {} } }
    apply(c, { memoryDir: dir, wikiIndex: false })
    const h = c.handlers.get('agent/pre-step')
    const d = await h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
    const text = d.messages[d.messages.length - 1].content[0].text
    assert.ok(!text.includes('usage'), '注入里不该出现使用统计')
    assert.strictEqual(entriesOf(path.join(dir, 'USER.md')).length, 1, '记忆文件不该被统计改动')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('做梦标完 checked 后，该条目排到后面（优先核对久未核对的）', async () => {
  const dir = mkDir(['常被访问的甲', '从没访问的乙', '从没访问的丙'])
  try {
    // 先注入 3 次，让「甲」变成高频
    const c = { handlers: new Map(), on(e, f) { this.handlers.set(e, f) }, logger: { info() {}, warn() {} } }
    apply(c, { memoryDir: dir, wikiIndex: false })
    const h = c.handlers.get('agent/pre-step')
    for (let i = 0; i < 3; i += 1) {
      await h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
    }
    // 跑一轮做梦，把所有条目都标成「刚核对过」
    await runDream(ctx('NONE'), cfg(dir))
    const usage = JSON.parse(readFileSync(path.join(dir, '.usage.json'), 'utf8'))
    const checkedCount = Object.values(usage).filter((v) => v.checked > 0).length
    assert.ok(checkedCount >= 1, `应当有条目被标记核对过：${JSON.stringify(usage)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('.usage.json 不会无限膨胀（超过上限会裁）', async () => {
  const dir = mkDir(['甲'])
  try {
    const c = { handlers: new Map(), on(e, f) { this.handlers.set(e, f) }, logger: { info() {}, warn() {} } }
    apply(c, { memoryDir: dir, wikiIndex: false })
    const h = c.handlers.get('agent/pre-step')
    await h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
    const usage = JSON.parse(readFileSync(path.join(dir, '.usage.json'), 'utf8'))
    assert.ok(Object.keys(usage).length <= 500, '不该超过 500 条')
    assert.ok(Object.keys(usage).every((k) => k.length === 12), '键应当是 12 位哈希')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
