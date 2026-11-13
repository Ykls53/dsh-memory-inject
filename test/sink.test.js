/**
 * 细节下沉测试：对齐 Anthropic 文章「把细节移到层级下方、只留链接」。
 * 关键约束：预算满时**先挪进归档页**，挪成功才从记忆里移除 —— 内容不能丢。
 * 跑法：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

const DELIM = '\n§\n'
const entriesOf = (p) => readFileSync(p, 'utf8').split(/\n\s*§\s*\n/).map((s) => s.trim()).filter(Boolean)

/** 上限：初始 6 条约 255 字符，再加一条必超 → 触发下沉。 */
const TIGHT = 260

/** 造一个「快满」的 USER.md。 */
function mkTightDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sink-'))
  const items = Array.from({ length: 6 }, (_, i) => `第${i + 1}条：` + '内容'.repeat(18))
  writeFileSync(path.join(dir, 'USER.md'), items.join(DELIM) + '\n', 'utf8')
  return { dir, items }
}

/** 走真实写入路径：把 content 写进 user。 */
async function addMemory(dir, content, maxChars) {
  let writer
  const tools = { register(spec) { if (spec?.name === 'memory_remember') writer = spec } }
  const ctx = {
    handlers: new Map(),
    on(e, f) { this.handlers.set(e, f) },
    // tools 必须在 apply 之前就取得到（插件是 whenReady 里同步注册的）
    get: (n) => (n === 'tools' ? tools : undefined),
    logger: { info() {}, warn() {} },
    inject: (_deps, cb) => { try { cb(ctx) } catch { /* 忽略 */ } },
    effect: () => {},
  }
  apply(ctx, { memoryDir: dir, files: [{ name: 'USER.md', heading: 'U', maxChars }], maxTotalChars: 4000 })
  for (let i = 0; i < 30 && !writer; i += 1) await new Promise((r) => setTimeout(r, 10))
  if (!writer) throw new Error('memory_remember 没注册上')
  return writer.execute({ target: 'user', action: 'add', content })
}

test('预算满时：细节下沉到归档页，内容不丢', async () => {
  const { dir, items } = mkTightDir()
  try {
    const r = await addMemory(dir, '新增的一条重要记忆内容', TIGHT)
    assert.ok(r.ok, `写入应当成功：${JSON.stringify(r)}`)
    const after = entriesOf(path.join(dir, 'USER.md'))
    assert.ok(after.includes('新增的一条重要记忆内容'), '新条目要写进去')
    assert.ok(after.length < items.length + 1, '得腾出位置，条数不能只增不减')

    const archivePath = path.join(dir, 'wiki', '归档.md')
    assert.ok(existsSync(archivePath), '应当生成归档页')
    const archive = readFileSync(archivePath, 'utf8')
    const sunk = r.sunk || []
    assert.ok(sunk.length > 0, `应当有下沉的条目：${JSON.stringify(r)}`)
    for (const t of sunk) {
      assert.ok(archive.includes(t.trim()), `下沉的条目必须完整在归档页里：${t.slice(0, 30)}`)
    }
    console.log(`     下沉 ${sunk.length} 条｜记忆 ${items.length}→${after.length} 条｜归档页 ${archive.length} 字符`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('下沉后：原条目要么在记忆里、要么在归档里，不能凭空消失', async () => {
  const { dir, items } = mkTightDir()
  try {
    const r = await addMemory(dir, '新增条目内容甲乙丙', TIGHT)
    const after = entriesOf(path.join(dir, 'USER.md'))
    const sunk = r.sunk || []
    for (const it of items) {
      const inMem = after.includes(it)
      const inArc = sunk.includes(it)
      assert.ok(inMem || inArc, `原条目不能凭空消失：${it.slice(0, 30)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('归档页不会被写重复（同一条下沉两次只留一份）', async () => {
  const { dir } = mkTightDir()
  try {
    await addMemory(dir, '新增条目一', TIGHT)
    const arc = path.join(dir, 'wiki', '归档.md')
    if (!existsSync(arc)) return
    await addMemory(dir, '新增条目二', TIGHT)
    const lines = readFileSync(arc, 'utf8').split(/\r?\n/).filter((l) => /^-\s+\S/.test(l))
    const uniq = new Set(lines)
    assert.strictEqual(lines.length, uniq.size, '归档页不该有重复条目')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('归档页会出现在 wiki 主题索引里（模型能查到）', async () => {
  const { dir } = mkTightDir()
  try {
    await addMemory(dir, '新增条目甲乙丙丁', TIGHT)
    const arc = path.join(dir, 'wiki', '归档.md')
    if (!existsSync(arc)) return
    const ctx = { handlers: new Map(), on(e, f) { this.handlers.set(e, f) }, logger: { info() {}, warn() {} } }
    apply(ctx, { memoryDir: dir })
    const h = ctx.handlers.get('agent/pre-step')
    const d = await h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
    const text = d.messages[d.messages.length - 1].content[0].text
    assert.ok(text.includes('## WIKI'), '应当有 wiki 索引')
    assert.ok(text.includes('归档'), '归档主题应当出现在索引里')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
