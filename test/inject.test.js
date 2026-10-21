/**
 * 离线测试：不装进 DSH、不重启客户端，也能验证注入逻辑对不对。
 * 跑法：npm test   （或 node --test test/）
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

const SOURCE_KIND = 'plugin:dsh-memory-inject'

/** 造一个最小可用的 Cordis ctx：只要 on 和 logger。 */
function makeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(event, fn) { handlers.set(event, fn) },
    logger: { info() {}, warn() {} },
  }
}

/** 跑一次 pre-step，返回框架拿到的 decision。 */
async function runPreStep(config, messages = [], event = {}) {
  const ctx = makeCtx()
  apply(ctx, config)
  const handler = ctx.handlers.get('agent/pre-step')
  assert.ok(handler, '插件应当注册 agent/pre-step')
  return handler(
    { step: 1, turn: 1, signal: { aborted: false }, ...event },
    async () => ({ kind: 'enter', messages }),
  )
}

/** 临时记忆目录 + 两份文件。 */
function withMemoryDir(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-inject-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, 'utf-8')
  }
  return dir
}

test('正常注入：把 USER.md 和 MEMORY.md 拼成一条消息', async () => {
  const dir = withMemoryDir({
    'USER.md': '主人自称伊卡洛斯。\n§\n讨厌客套话。',
    'MEMORY.md': '工作区在 D:\\deepseekDAIGirlfriend。',
  })
  try {
    const decision = await runPreStep({ memoryDir: dir }, [{ role: 'user', content: [] }])
    assert.strictEqual(decision.messages.length, 2, '应当在原有消息后追加一条')
    const injected = decision.messages[1]
    assert.strictEqual(injected.source.kind, SOURCE_KIND)
    const text = injected.content[0].text
    assert.match(text, /伊卡洛斯/)
    assert.match(text, /deepseekDAIGirlfriend/)
    assert.match(text, /不是新的用户输入/, '应当带上「这是记忆不是新输入」的说明')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('去重：历史里已有注入标记就不再注入', async () => {
  const dir = withMemoryDir({ 'USER.md': '一条画像' })
  try {
    const existing = {
      role: 'user',
      content: [{ type: 'text', text: '旧注入' }],
      source: { kind: SOURCE_KIND, form: 'snapshot', sections: [] },
    }
    const decision = await runPreStep({ memoryDir: dir }, [existing])
    assert.strictEqual(decision.messages.length, 1, '不应重复追加')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空目录：不注入、原样返回，也不抛错', async () => {
  const dir = withMemoryDir({})
  try {
    const original = [{ role: 'user', content: [] }]
    const decision = await runPreStep({ memoryDir: dir }, original)
    assert.deepStrictEqual(decision.messages, original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录不存在：静默跳过', async () => {
  const decision = await runPreStep(
    { memoryDir: path.join(os.tmpdir(), 'this-dir-should-not-exist-9f3a') },
    [],
  )
  assert.deepStrictEqual(decision.messages, [])
})

test('预算守门：第一个文件就超预算时整份跳过', async () => {
  const dir = withMemoryDir({ 'USER.md': 'x'.repeat(500) })
  try {
    const decision = await runPreStep({ memoryDir: dir, maxTotalChars: 100 }, [])
    assert.strictEqual(decision.messages.length, 0, '超预算不该硬塞')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只处理第一步：step 2 不注入', async () => {
  const dir = withMemoryDir({ 'USER.md': '一条画像' })
  try {
    const decision = await runPreStep({ memoryDir: dir }, [], { step: 2 })
    assert.strictEqual(decision.messages.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('turns 白名单：不在名单里的 turn 不注入', async () => {
  const dir = withMemoryDir({ 'USER.md': '一条画像' })
  try {
    const decision = await runPreStep({ memoryDir: dir, turns: [1] }, [], { turn: 5 })
    assert.strictEqual(decision.messages.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('被拒的轮次不注入', async () => {
  const ctx = makeCtx()
  apply(ctx, { memoryDir: withMemoryDir({ 'USER.md': 'x' }) })
  const handler = ctx.handlers.get('agent/pre-step')
  const decision = await handler({ step: 1, turn: 1 }, async () => ({ kind: 'reject' }))
  assert.strictEqual(decision.kind, 'reject')
  assert.strictEqual(decision.messages, undefined)
})
