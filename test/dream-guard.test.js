/**
 * 做梦只做增量：模型只报操作，没被点名的条目原样保留。
 * 2026-11-14 两次血的教训：整份重写会把记忆压掉（7 条 USER 被压成 386 字符、
 * 9 条 MEMORY 被砍成 5 条）。改成操作式后，从根上不可能丢没被提到的条目。
 * 跑法：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runDream } from '../index.js'

const DELIM = '\n§\n'

function llmReturning(text) {
  return {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** 造临时记忆目录（user 条 + 固定一条 memory）。 */
function makeDir(userEntries, envEntries = ['环境规则一条']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dream-ops-'))
  writeFileSync(path.join(dir, 'USER.md'), userEntries.join(DELIM) + '\n', 'utf-8')
  writeFileSync(path.join(dir, 'MEMORY.md'), envEntries.join(DELIM) + '\n', 'utf-8')
  return dir
}

function cfgFor(dir) {
  return {
    memoryDir: dir,
    files: [
      { name: 'USER.md', maxChars: 4000 },
      { name: 'MEMORY.md', maxChars: 4000 },
    ],
    extractProvider: 'test-provider',
    extractModel: 'test-model',
  }
}

function ctxWith(text) {
  return { get: (n) => (n === 'llm' ? llmReturning(text) : undefined), logger: { info() {}, warn() {} } }
}

test('NONE：没有任何操作时一条都不动', async () => {
  const dir = makeDir(['第一条', '第二条', '第三条'])
  const before = readFileSync(path.join(dir, 'USER.md'), 'utf-8')
  try {
    const r = await runDream(ctxWith('NONE'), cfgFor(dir))
    assert.strictEqual(readFileSync(path.join(dir, 'USER.md'), 'utf-8'), before)
    assert.strictEqual(r.changed, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX：只改被点名的那条，其他条目原样保留', async () => {
  const dir = makeDir(['旧端口是 8080', '第二条不受影响', '第三条也不动'])
  try {
    // 编号 1 = USER 第 1 条
    const r = await runDream(ctxWith('FIX 1 => 端口改成 8096，2026-11-14 起生效'), cfgFor(dir))
    const after = readFileSync(path.join(dir, 'USER.md'), 'utf-8')
    assert.match(after, /8096/, '被点名的那条应当改掉')
    assert.ok(!after.includes('旧端口是 8080'), '旧内容应当被替换')
    assert.match(after, /第二条不受影响/, '没被提到的条目必须原样保留')
    assert.match(after, /第三条也不动/, '没被提到的条目必须原样保留')
    assert.strictEqual(r.changed, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DROP：删一条，其余全保留', async () => {
  const dir = makeDir(['要删的错误记忆', '要留的甲', '要留的乙'])
  try {
    await runDream(ctxWith('DROP 1'), cfgFor(dir))
    const after = readFileSync(path.join(dir, 'USER.md'), 'utf-8')
    assert.ok(!after.includes('要删的错误记忆'))
    assert.match(after, /要留的甲/)
    assert.match(after, /要留的乙/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ADD：只追加，现有条目一条不少', async () => {
  const dir = makeDir(['现有甲', '现有乙'])
  try {
    await runDream(ctxWith('ADD ENV: 新发现的环境事实'), cfgFor(dir))
    const after = readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8')
    assert.match(after, /新发现的环境事实/, '应当追加新条目')
    assert.match(after, /环境规则一条/, '原条目必须保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('批量：9 条里只改 1 条，其余 8 条一条不少（上次被压掉的情形）', async () => {
  const nine = ['一', '二', '三', '四', '五', '六', '七', '八', '九'].map((n) => `第${n}条环境事实，内容完整保留`)
  const dir = makeDir(nine)
  try {
    await runDream(ctxWith('FIX 3 => 第3条改过了，其余原样'), cfgFor(dir))
    const after = readFileSync(path.join(dir, 'USER.md'), 'utf-8')
    const count = after.split(/\n\s*§\s*\n/).filter((s) => s.trim()).length
    assert.strictEqual(count, 9, '9 条必须还是 9 条')
    assert.match(after, /第3条改过了/)
    for (const n of ['一', '二', '四', '五', '六', '七', '八', '九']) {
      assert.ok(after.includes(`第${n}条`), `第${n}条必须原样保留`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('越界/乱写的编号一律忽略，文件不动', async () => {
  const dir = makeDir(['唯一一条'])
  const before = readFileSync(path.join(dir, 'USER.md'), 'utf-8')
  try {
    const r = await runDream(ctxWith('FIX 99 => 不存在的编号\nDROP abc\n随便说点什么'), cfgFor(dir))
    assert.strictEqual(readFileSync(path.join(dir, 'USER.md'), 'utf-8'), before)
    assert.strictEqual(r.changed, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删太狠会被兜底拦住：10 条删到只剩 2 条这轮不写', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => `第${i + 1}条内容`)
  const dir = makeDir(ten)
  const before = readFileSync(path.join(dir, 'USER.md'), 'utf-8')
  try {
    const drops = Array.from({ length: 8 }, (_, i) => `DROP ${i + 1}`).join('\n')
    const r = await runDream(ctxWith(drops), cfgFor(dir))
    assert.strictEqual(readFileSync(path.join(dir, 'USER.md'), 'utf-8'), before, '删太多不该落盘')
    assert.ok((r.skipped || []).length > 0, '应当报告被拦')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
