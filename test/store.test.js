/**
 * 读写层的离线测试：原子批量、精确 patch、预算守门、备份。
 * 跑法：node --test test/store.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseEntries, renderEntries, readStore, writeStore, patchStore, batchStore } from '../lib/store.mjs'

function tmpDir(files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memstore-'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body, 'utf-8')
  }
  return dir
}

test('条目解析与还原：往返不丢东西', () => {
  const text = '第一条事实\n\n§\n\n第二条事实\n\n§\n第三条'
  const entries = parseEntries(text)
  assert.deepStrictEqual(entries, ['第一条事实', '第二条事实', '第三条'])
  assert.strictEqual(readStore(tmpDir({ 'X.md': renderEntries(entries) }), 'X.md').entries.length, 3)
})

test('空文件 / 不存在文件都返回空条目', () => {
  const dir = tmpDir({ 'E.md': '   \n\n' })
  assert.deepStrictEqual(readStore(dir, 'E.md').entries, [])
  assert.strictEqual(readStore(dir, 'NOPE.md').exists, false)
})

test('预算守门：超了直接拒绝，不截断', () => {
  const dir = tmpDir({})
  const res = writeStore(dir, 'M.md', ['x'.repeat(200)], { maxChars: 100 })
  assert.strictEqual(res.ok, false)
  assert.match(res.error, /超预算/)
  assert.strictEqual(existsSync(path.join(dir, 'M.md')), false, '被拒时不该落盘')
})

test('原子批量：先删后加，预算只看最终结果', () => {
  const dir = tmpDir({ 'M.md': renderEntries(['旧的占位条目'.repeat(10), '要保留的一条']) })
  // 单看「删+加」的中间态会超，但最终结果很短 → 应当通过
  const res = batchStore(
    dir,
    'M.md',
    { remove: ['旧的占位条目'], add: ['新的一条'] },
    { maxChars: 200 },
  )
  assert.strictEqual(res.ok, true, res.error)
  const after = readStore(dir, 'M.md').entries
  assert.strictEqual(after.length, 2)
  assert.ok(after.includes('要保留的一条'))
  assert.ok(after.includes('新的一条'))
  assert.deepStrictEqual(res.applied, { removed: 1, added: 1, replaced: 0 })
})

test('原子性：remove 没命中就整批失败，不落盘', () => {
  const dir = tmpDir({ 'M.md': renderEntries(['甲', '乙']) })
  const before = readFileSync(path.join(dir, 'M.md'), 'utf-8')
  const res = batchStore(dir, 'M.md', { remove: ['不存在的条目'], add: ['丙'] })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(readFileSync(path.join(dir, 'M.md'), 'utf-8'), before)
})

test('精确 patch：唯一命中才改', () => {
  const dir = tmpDir({ 'U.md': renderEntries(['喜欢简短回答', '常用 PowerShell']) })
  const res = patchStore(dir, 'U.md', { oldText: '简短', newText: '简洁' })
  assert.strictEqual(res.ok, true, res.error)
  assert.ok(readStore(dir, 'U.md').entries.some((e) => e.includes('简洁回答')))
})

test('精确 patch：命中多条时拒绝（不猜着改）', () => {
  const dir = tmpDir({ 'U.md': renderEntries(['端口 8080', '端口 8096']) })
  const res = patchStore(dir, 'U.md', { oldText: '端口', newText: 'PORT' })
  assert.strictEqual(res.ok, false)
  assert.match(res.error, /不唯一/)
})

test('写前自动备份，备份里是旧内容', () => {
  const dir = tmpDir({ 'M.md': renderEntries(['旧内容']) })
  const res = writeStore(dir, 'M.md', ['新内容'])
  assert.strictEqual(res.ok, true)
  assert.ok(res.backup, '应当返回备份路径')
  const bak = readFileSync(path.join(dir, res.backup), 'utf-8')
  assert.ok(bak.includes('旧内容'), '备份里必须是旧内容')
  assert.ok(readFileSync(path.join(dir, 'M.md'), 'utf-8').includes('新内容'))
})

test('重复加同一条不重复入列', () => {
  const dir = tmpDir({ 'M.md': renderEntries(['已经在这了']) })
  const res = batchStore(dir, 'M.md', { add: ['已经在这了'] })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.applied.added, 0)
  assert.strictEqual(readStore(dir, 'M.md').entries.length, 1)
})
