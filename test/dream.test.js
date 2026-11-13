/**
 * 离线测试：做梦的操作指令解析（parseDreamOps）。
 *
 * 2026-11-14 改：做梦从「模型输出完整清单、代码整份覆盖」改成「模型只报操作、
 * 代码拿原文逐条执行」。parseDream（旧的 [USER]/[ENV] 区块解析）已废弃，
 * 这里改测操作式解析。
 *
 * 跑法：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert'

import { parseDreamOps } from '../index.js'

// USER 3 条、MEMORY 2 条 → 编号 1..3 是 USER，4..5 是 MEMORY
const COUNTS = { user: 3, env: 2 }

test('FIX：带 => 的改写操作', () => {
  const ops = parseDreamOps('FIX 1 => 端口改成 8096', COUNTS)
  assert.deepStrictEqual(ops, [{ op: 'fix', target: 'user', idx: 0, text: '端口改成 8096' }])
})

test('FIX：认 → 和 : 两种分隔符', () => {
  assert.strictEqual(parseDreamOps('FIX 2 → 新的内容甲乙', COUNTS)[0]?.text, '新的内容甲乙')
  assert.strictEqual(parseDreamOps('FIX 2: 新的内容甲乙', COUNTS)[0]?.text, '新的内容甲乙')
})

test('FIX：容忍 markdown 装饰（粗体/列表符/编号前缀）', () => {
  for (const s of ['**FIX 1 => 内容甲乙**', '- FIX 1 => 内容甲乙', '1. FIX 1 => 内容甲乙', 'FIX #1 => 内容甲乙']) {
    const ops = parseDreamOps(s, COUNTS)
    assert.strictEqual(ops[0]?.op, 'fix', s)
    assert.strictEqual(ops[0]?.text, '内容甲乙', s)
  }
})

test('DROP：删一条', () => {
  assert.deepStrictEqual(parseDreamOps('DROP 2', COUNTS), [{ op: 'drop', target: 'user', idx: 1 }])
})

test('ADD：按 USER / ENV 分别归位', () => {
  const ops = parseDreamOps('ADD USER: 新画像一条\nADD ENV: 新环境一条', COUNTS)
  assert.strictEqual(ops.length, 2)
  assert.strictEqual(ops[0].target, 'user')
  assert.strictEqual(ops[1].target, 'env')
})

test('编号归属：1..3 是 USER，4..5 是 MEMORY', () => {
  assert.strictEqual(parseDreamOps('FIX 3 => 改第三条', COUNTS)[0]?.target, 'user')
  assert.strictEqual(parseDreamOps('FIX 4 => 改第四条', COUNTS)[0]?.target, 'env')
  assert.strictEqual(parseDreamOps('FIX 4 => 改第四条', COUNTS)[0]?.idx, 0)
  assert.strictEqual(parseDreamOps('FIX 5 => 改第五条', COUNTS)[0]?.idx, 1)
})

test('越界编号一律丢弃（宁可不改）', () => {
  assert.deepStrictEqual(parseDreamOps('FIX 99 => 不存在', COUNTS), [])
  assert.deepStrictEqual(parseDreamOps('DROP 0', COUNTS), [])
  assert.deepStrictEqual(parseDreamOps('DROP 6', COUNTS), [])
})

test('NONE 与噪声行跳过', () => {
  assert.deepStrictEqual(parseDreamOps('NONE', COUNTS), [])
  assert.deepStrictEqual(parseDreamOps('好的，我看完了\n再想想', COUNTS), [])
  assert.deepStrictEqual(parseDreamOps('', COUNTS), [])
})

test('内容太短的不收（防写进残句）', () => {
  assert.deepStrictEqual(parseDreamOps('FIX 1 => 短', COUNTS), [])
  assert.deepStrictEqual(parseDreamOps('ADD ENV: 略', COUNTS), [])
})

test('混合多行：只收认得的，其余忽略', () => {
  const ops = parseDreamOps(
    ['看完了，结论如下：', 'FIX 1 => 第一条改过', '顺便说一句废话', 'DROP 4', 'NONE'].join('\n'),
    COUNTS,
  )
  assert.strictEqual(ops.length, 2)
  assert.strictEqual(ops[0].op, 'fix')
  assert.strictEqual(ops[1].op, 'drop')
  assert.strictEqual(ops[1].target, 'env')
})
