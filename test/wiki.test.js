/**
 * 表征层（wiki）测试：对齐 Anthropic 文章里「dreaming 构建表征」。
 * 关键约束：wiki 正文**不进注入区**（文章警告顶层必须小），注入里只带极小索引。
 * 跑法：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, parseWikiOps, runDream, DEFAULTS } from '../index.js'

const DELIM = '\n§\n'
function mkDirWith(user = ['画像一条'], env = ['环境一条']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wiki-'))
  writeFileSync(path.join(dir, 'USER.md'), user.join(DELIM) + '\n', 'utf8')
  writeFileSync(path.join(dir, 'MEMORY.md'), env.join(DELIM) + '\n', 'utf8')
  return dir
}
function writeWiki(dir, topic, body) {
  const d = path.join(dir, 'wiki')
  mkdirSync(d, { recursive: true })
  writeFileSync(path.join(d, topic + '.md'), body, 'utf8')
}

test('parseWikiOps：解析多行主题页正文', () => {
  const ops = parseWikiOps(
    ['WIKI PS5开发', 'PS5 自制应用与文件传输的要点。', '', '要点一：文件夹版文件越少越安全', '相关：记忆插件'].join('\n'),
  )
  assert.strictEqual(ops.length, 1)
  assert.strictEqual(ops[0].topic, 'PS5开发')
  assert.ok(ops[0].body.includes('文件夹版文件越少越安全'))
})

test('parseWikiOps：遇到 FIX/DROP 就结束当前 wiki 块', () => {
  const ops = parseWikiOps(['WIKI 主题甲', '这是主题甲的正文内容够长了', 'FIX 1 => 改了一条记忆', 'DROP 2'].join('\n'))
  assert.strictEqual(ops.length, 1)
  assert.strictEqual(ops[0].topic, '主题甲')
  assert.ok(!ops[0].body.includes('改了一条记忆'), '不该把别的操作揉进 wiki 正文')
})

test('parseWikiOps：正文太短的丢弃', () => {
  assert.strictEqual(parseWikiOps('WIKI 短\n略').length, 0)
})

test('parseWikiOps：非法字符从主题名里剔掉', () => {
  const ops = parseWikiOps('WIKI a/b:c*d\n这是一段足够长的正文内容')
  assert.strictEqual(ops[0].topic, 'abcd')
})

test('注入：wiki 正文不进注入区，只带主题索引', () => {
  const dir = mkDirWith()
  writeWiki(dir, 'PS5开发', '# PS5 自制应用要点\n'.repeat(50) + '正文很长'.repeat(200))
  const ctx = { handlers: new Map(), on(e, f) { this.handlers.set(e, f) }, logger: { info() {}, warn() {} } }
  apply(ctx, { memoryDir: dir })
  const h = ctx.handlers.get('agent/pre-step')
  return h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] })).then((d) => {
    const text = d.messages[d.messages.length - 1].content[0].text
    assert.ok(text.includes('PS5开发'), '索引里要有主题名')
    assert.ok(!text.includes('正文很长正文很长正文很长'), 'wiki 正文绝不能被整篇注入')
    assert.ok(text.length < 4000, '注入体积要受控')
    rmSync(dir, { recursive: true, force: true })
  })
})

test('注入：没有 wiki 时不出现 WIKI 段', () => {
  const dir = mkDirWith()
  const ctx = { handlers: new Map(), on(e, f) { this.handlers.set(e, f) }, logger: { info() {}, warn() {} } }
  apply(ctx, { memoryDir: dir })
  const h = ctx.handlers.get('agent/pre-step')
  return h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] })).then((d) => {
    const text = d.messages[d.messages.length - 1].content[0].text
    assert.ok(!text.includes('## WIKI'), '没 wiki 就不该有 WIKI 段')
    rmSync(dir, { recursive: true, force: true })
  })
})

test('注入：wikiIndex=false 时关掉索引', () => {
  const dir = mkDirWith()
  writeWiki(dir, '主题甲', '主题甲的一句话说明\n正文')
  const ctx = { handlers: new Map(), on(e, f) { this.handlers.set(e, f) }, logger: { info() {}, warn() {} } }
  apply(ctx, { memoryDir: dir, wikiIndex: false })
  const h = ctx.handlers.get('agent/pre-step')
  return h({ step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] })).then((d) => {
    const text = d.messages[d.messages.length - 1].content[0].text
    assert.ok(!text.includes('## WIKI'), '关掉后不该有索引')
    rmSync(dir, { recursive: true, force: true })
  })
})

test('做梦：能写 wiki 主题页，且不动记忆条目', async () => {
  const dir = mkDirWith(['画像甲', '画像乙'])
  const before = readFileSync(path.join(dir, 'USER.md'), 'utf8')
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'WIKI 记忆插件\n记忆插件的整体要点归拢。\n要点一：增量操作不整份重写\n要点二：做梦拿转录当依据' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = { get: (n) => (n === 'llm' ? llm : undefined), logger: { info() {}, warn() {} } }
  const r = await runDream(ctx, { ...DEFAULTS, memoryDir: dir, extractProvider: 'p', extractModel: 'm' })
  assert.ok(existsSync(path.join(dir, 'wiki', '记忆插件.md')), 'wiki 页应当生成')
  assert.strictEqual(readFileSync(path.join(dir, 'USER.md'), 'utf8'), before, '记忆条目不该被动')
  assert.ok(r.changed >= 1)
  rmSync(dir, { recursive: true, force: true })
})

test('做梦：wiki 与记忆操作能同时生效', async () => {
  const dir = mkDirWith(['旧画像内容'])
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'FIX 1 => 新画像内容改过了\nWIKI 主题乙\n主题乙的说明文字，够长了。\n要点若干' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = { get: (n) => (n === 'llm' ? llm : undefined), logger: { info() {}, warn() {} } }
  await runDream(ctx, { ...DEFAULTS, memoryDir: dir, extractProvider: 'p', extractModel: 'm' })
  const u = readFileSync(path.join(dir, 'USER.md'), 'utf8')
  assert.ok(u.includes('新画像内容改过了'), 'FIX 应当生效')
  assert.ok(existsSync(path.join(dir, 'wiki', '主题乙.md')), 'wiki 也应当生成')
  rmSync(dir, { recursive: true, force: true })
})
