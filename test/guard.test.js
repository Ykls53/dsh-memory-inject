/**
 * 提炼守卫 + 提炼黑名单的回归测试（2026-10-28 加）。
 *
 * 守的是主人那两句抱怨：
 *   ①「我自己删了错误的或者不想要的，提炼一轮还会加回来」→ 墓碑 + 相似度闸
 *   ②「每次手动点会多一堆会话」「QQ 机器人的记忆写进来」→ cwd/preset 黑名单
 *
 * 跑法：node --test test/guard.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, _resetRecentTurns } from '../index.js'

const BASE = '/api/memory-inject'

function makeCtx() {
  const handlers = new Map()
  const ctx = {
    handlers,
    registeredTools: [],
    route: null,
    logger: { info() {}, warn() {}, error() {} },
    on(ev, fn) {
      handlers.set(ev, fn)
    },
    effect(fn) {
      try {
        fn()
      } catch {
        /* 注册失败不该影响测试 */
      }
    },
  }
  ctx.tools = { register: (spec) => ctx.registeredTools.push(spec) }
  ctx.webServer = { register: (spec) => (ctx.route = spec) }
  ctx.get = (name) => ctx[name]
  ctx.inject = (deps, cb) => {
    cb(ctx)
    return null
  }
  return ctx
}

function makeReq(method, url, payload) {
  const evs = {}
  const req = {
    method,
    url,
    on(ev, fn) {
      ;(evs[ev] = evs[ev] || []).push(fn)
      return req
    },
  }
  // 跟 api.test.js 一致：setImmediate 里补 data / end，handler 才会往下走
  setImmediate(() => {
    if (payload !== undefined) (evs.data || []).forEach((f) => f(JSON.stringify(payload)))
    ;(evs.end || []).forEach((f) => f())
  })
  return req
}

function makeRes() {
  const res = { status: 0, body: null }
  res.writeHead = (s) => {
    res.status = s
  }
  res.end = (b) => {
    try {
      res.body = typeof b === 'string' ? JSON.parse(b) : b
    } catch {
      res.body = b
    }
  }
  return res
}

async function call(ctx, method, sub, payload) {
  const spec = ctx.route
  assert.ok(spec, '路由没注册上')
  const res = makeRes()
  await spec.handler(makeReq(method, BASE + sub, payload), res)
  return { status: res.status, body: res.body || {} }
}

/** 临时记忆目录；第二参数是初始条目。 */
function tmpMemory(list = ['甲：第一件事', '乙：第二件事']) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-guard-'))
  if (list) {
    writeFileSync(path.join(dir, 'USER.md'), list.join('\n§\n') + '\n', 'utf-8')
    writeFileSync(path.join(dir, 'MEMORY.md'), '环境：一行记一件事\n', 'utf-8')
  }
  return dir
}

/**
 * 关掉 HTTP 提炼通道，避免测试真去打网络；
 * captureTimeoutMs 压到 300ms —— 回退 headless 时也别真等 180 秒。
 * 每个用例先清「最近轮次」表：它是模块级状态，不清会把上一个用例的会话带进来。
 */
function boot(dir, extra = {}) {
  _resetRecentTurns()
  const ctx = makeCtx()
  apply(ctx, { memoryDir: dir, extractApiKeyEnv: '', captureTimeoutMs: 300, ...extra })
  return ctx
}

function rejectedOf(dir) {
  const p = path.join(dir, '.rejected.json')
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, 'utf-8')).items || []
  } catch {
    return []
  }
}

test('墓碑：整份覆盖删掉的条目会记下来', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'POST', '/write', {
      target: 'user',
      action: 'set',
      entries: ['甲：第一件事'], // 删掉了「乙：第二件事」
    })
    assert.strictEqual(r.status, 200, JSON.stringify(r.body))
    const items = rejectedOf(dir)
    assert.strictEqual(items.length, 1, '应当记下 1 条墓碑')
    assert.match(items[0].text, /乙：第二件事/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('墓碑：删过的条目换个说法也加不回来', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/write', { target: 'user', action: 'set', entries: ['甲：第一件事'] })
    // 换个说法讲同一件事
    const r = await call(ctx, 'POST', '/write', {
      target: 'user',
      action: 'add',
      content: '乙：第二件事（换个说法重写一遍）',
    })
    assert.strictEqual(r.body.ok, false, '应当被墓碑拦下：' + JSON.stringify(r.body))
    assert.strictEqual(r.body.rejected, true)
    const cur = await call(ctx, 'GET', '/state')
    const entries = cur.body.files[0].entries
    assert.strictEqual(entries.length, 1, '被拦下就不该写进去')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('去重：跟现有条目 ≥75% 相似就不重复加', async () => {
  const dir = tmpMemory(['DSH 桌面端端口每次都变，别写死 19387'])
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'POST', '/write', {
      target: 'user',
      action: 'add',
      content: 'DSH 桌面端端口每次都变，别写死 19387 端口',
    })
    assert.strictEqual(r.body.applied?.added ?? 0, 0, '相似条目不应当写入：' + JSON.stringify(r.body))
    assert.ok(r.body.duplicate || /相似/.test(r.body.note || ''), '应当标成重复：' + JSON.stringify(r.body))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('去重：全新条目照常写入（守卫不能把正常记忆也挡了）', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'POST', '/write', {
      target: 'memory',
      action: 'add',
      content: 'qqbot 插件日志在 C:\\Users\\Yk\\.dsh\\qqbot.log',
    })
    assert.strictEqual(r.status, 200, JSON.stringify(r.body))
    assert.strictEqual(r.body.applied?.added, 1, JSON.stringify(r.body))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('force：人当场点名要写回时可以越过墓碑', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/write', { target: 'user', action: 'set', entries: ['甲：第一件事'] })
    const r = await call(ctx, 'POST', '/write', {
      target: 'user',
      action: 'add',
      content: '乙：第二件事',
      force: true,
    })
    assert.strictEqual(r.body.applied?.added, 1, JSON.stringify(r.body))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 造一个能抽出正文的 fake 会话；noUser=true 时抽不出（用来测「没内容」分支，不触发真提炼）。 */
function fakeSession({ cwd, preset, id, noUser, text = '这一轮聊了很久，最后决定把记忆提炼改成 HTTP 直调。' } = {}) {
  const turn = 7
  const events = [
    { type: 'turn/start', data: { turn } },
    ...(noUser
      ? []
      : [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }]),
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好，改了。' }] } } },
    { type: 'turn/end', data: { turn } },
  ]
  return {
    id,
    header: { id, cwd, agentPreset: preset },
    snapshotEvents: () => events,
  }
}

async function fireTurnEnd(ctx, session) {
  const handler = ctx.handlers.get('session/event')
  assert.ok(handler, 'session/event 钩子没挂上')
  await handler(session, { type: 'turn/end', data: { turn: 7 } })
}

test('黑名单：qqbot 工作目录不提炼（手动点也拦）', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\qqbot' }))
    const r = await call(ctx, 'POST', '/capture')
    assert.strictEqual(r.status, 400, JSON.stringify(r.body))
    assert.match(r.body.error, /黑名单/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('多会话：qqbot 抢了最后一轮，点提炼仍会跳到桌面端那个会话', async () => {
  // 2026-10-29 的真事：全局 lastTurnRef 被群消息盖掉，主人在自己会话里点提炼被自己黑名单拦
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    // 桌面端会话先报一轮（noUser → 抽不出正文 → 400「没有可提炼的内容」，不会真去提炼）
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\deepseekDAIGirlfriend', id: 's-desktop', noUser: true }))
    await new Promise((r) => setTimeout(r, 5))
    // 紧接着 qqbot 会话报一轮，时序上更晚
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\qqbot', id: 's-qqbot' }))
    const r = await call(ctx, 'POST', '/capture')
    assert.strictEqual(r.status, 400, JSON.stringify(r.body))
    assert.doesNotMatch(r.body.error, /黑名单/, '不该再被机器人那轮的黑名单拦住：' + JSON.stringify(r.body))
    assert.match(r.body.error, /没有可提炼的内容/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('多会话：全都不可提炼时，错误里说清是哪个目录挡的', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\qqbot', id: 'a' }))
    await fireTurnEnd(ctx, fakeSession({ cwd: 'C:\\Users\\Yk\\.dsh\\bili-duty', id: 'b' }))
    const r = await call(ctx, 'POST', '/capture')
    assert.strictEqual(r.status, 400)
    assert.match(r.body.error, /都在提炼黑名单里/)
    assert.ok(Array.isArray(r.body.blocked) && r.body.blocked.length === 2, JSON.stringify(r.body))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('?session= 指定会话时不看时间先后', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\deepseekDAIGirlfriend', id: 's-desktop', noUser: true }))
    await new Promise((r) => setTimeout(r, 5))
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\qqbot', id: 's-qqbot' }))
    const r = await call(ctx, 'POST', '/capture?session=s-qqbot')
    assert.strictEqual(r.status, 400)
    assert.match(r.body.error, /黑名单/, '指定 qqbot 会话就该被拦：' + JSON.stringify(r.body))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/state 告诉面板「现在提炼会抓哪个会话」', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\qqbot', id: 'q' }))
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\deepseekDAIGirlfriend', id: 'd' }))
    const r = await call(ctx, 'GET', '/state')
    assert.strictEqual(r.body.capturableSession?.cwd, 'D:\\deepseekDAIGirlfriend', JSON.stringify(r.body.capturableSession))
    assert.ok(r.body.trackedSessions >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('黑名单：bili-duty 与记忆目录自身也不提炼', async () => {
  for (const cwd of ['C:\\Users\\Yk\\.dsh\\bili-duty', 'C:\\Users\\Yk\\.dsh\\memories']) {
    const dir = tmpMemory()
    try {
      const ctx = boot(dir)
      await fireTurnEnd(ctx, fakeSession({ cwd }))
      const r = await call(ctx, 'POST', '/capture')
      assert.strictEqual(r.status, 400, `${cwd} 应当被拦：${JSON.stringify(r.body)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('黑名单：preset 是 qqbot 的会话也拦', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await fireTurnEnd(ctx, fakeSession({ cwd: 'D:\\项目', preset: 'qqbot' }))
    const r = await call(ctx, 'POST', '/capture')
    assert.strictEqual(r.status, 400, JSON.stringify(r.body))
    assert.match(r.body.error, /preset/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/state 暴露墓碑与黑名单，面板能看见', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/write', { target: 'user', action: 'set', entries: ['甲：第一件事'] })
    const r = await call(ctx, 'GET', '/state')
    assert.ok(r.body.rejectedCount >= 1, JSON.stringify(r.body))
    assert.ok(Array.isArray(r.body.skipCaptureCwds) && r.body.skipCaptureCwds.length >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 预算腾位 + 手动锁定（2026-10-29 加）──────────────────────────────

/** 造一个「预算吃紧 + 有条目重复」的记忆目录。 */
function tmpTightMemory() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-evict-'))
  const memory = [
    '甲：DSH 桌面端端口每次都变，别写死 19387',
    '乙：DSH 桌面端端口每次都变，别写死 19387 端口',
    '丙：B站插件报告落 C:\\Users\\Yk\\.dsh\\bili-duty\\out\\2026-10-28.md',
  ]
  writeFileSync(path.join(dir, 'MEMORY.md'), memory.join('\n§\n') + '\n', 'utf-8')
  writeFileSync(path.join(dir, 'USER.md'), '主人自称主人\n', 'utf-8')
  return dir
}

function readMemory(dir) {
  return readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8')
}

function evictedOf(dir) {
  const p = path.join(dir, '.evicted.json')
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, 'utf-8')).items || []
  } catch {
    return []
  }
}

test('腾位：预算满了自动顶掉重复条目，新事实写得进去', async () => {
  const dir = tmpTightMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/config', { limits: { 'MEMORY.md': 130 } })
    const r = await call(ctx, 'POST', '/write', {
      target: 'memory',
      action: 'add',
      content: '丁：qqbot 插件日志在 C:\\Users\\Yk\\.dsh\\qqbot.log',
    })
    assert.strictEqual(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.evicted?.length >= 1, '应当至少顶掉 1 条：' + JSON.stringify(r.body))
    const body = readMemory(dir)
    assert.match(body, /丁：qqbot 插件日志/)
    assert.doesNotMatch(body, /甲：DSH 桌面端端口/, '重复且更短的那条应先被顶掉')
    assert.ok(evictedOf(dir).length >= 1, '.evicted.json 要留记录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('腾位：锁住的条目一条都不动，去顶别的', async () => {
  const dir = tmpTightMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/config', { limits: { 'MEMORY.md': 130 } })
    const pin = await call(ctx, 'POST', '/pin', {
      file: 'MEMORY.md',
      text: '甲：DSH 桌面端端口每次都变，别写死 19387',
      pinned: true,
    })
    assert.strictEqual(pin.status, 200, JSON.stringify(pin.body))
    const r = await call(ctx, 'POST', '/write', {
      target: 'memory',
      action: 'add',
      content: '丁：qqbot 插件日志在 C:\\Users\\Yk\\.dsh\\qqbot.log',
    })
    assert.strictEqual(r.status, 200, JSON.stringify(r.body))
    const body = readMemory(dir)
    assert.match(body, /甲：DSH 桌面端端口/, '锁住的那条不许被顶掉')
    assert.match(body, /丁：qqbot 插件日志/)
    assert.doesNotMatch(body, /乙：DSH 桌面端端口/, '该顶的是没锁的那条重复项')
    assert.ok(r.body.evicted.every((e) => !e.text.startsWith('甲：')), JSON.stringify(r.body.evicted))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('腾位：全都锁住且塞不下时，明确报「没有可顶掉的」而不是静默丢内容', async () => {
  const dir = tmpTightMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/config', { limits: { 'MEMORY.md': 130 } })
    for (const t of [
      '甲：DSH 桌面端端口每次都变，别写死 19387',
      '乙：DSH 桌面端端口每次都变，别写死 19387 端口',
    ]) {
      await call(ctx, 'POST', '/pin', { file: 'MEMORY.md', text: t, pinned: true })
    }
    const r = await call(ctx, 'POST', '/write', {
      target: 'memory',
      action: 'add',
      content: '丁：一条很长的新事实，长到肯定塞不进去，用来触发腾位失败的分支处理。',
    })
    // 还有「丙」可以顶，所以这里仍然是成功；把丙也锁上再试
    if (r.status === 200) {
      await call(ctx, 'POST', '/pin', {
        file: 'MEMORY.md',
        text: '丙：B站插件报告落 C:\\Users\\Yk\\.dsh\\bili-duty\\out\\2026-10-28.md',
        pinned: true,
      })
      const r2 = await call(ctx, 'POST', '/write', {
        target: 'memory',
        action: 'add',
        content: '戊：另一条很长的新事实，长到肯定塞不进去，用来触发腾位失败的分支处理。',
      })
      assert.strictEqual(r2.body.ok, false, JSON.stringify(r2.body))
      assert.match(r2.body.error, /没有可顶掉/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('锁定：/pin 开关与 /state 都能看见', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const text = '甲：第一件事'
    const on = await call(ctx, 'POST', '/pin', { file: 'USER.md', text, pinned: true })
    assert.strictEqual(on.status, 200, JSON.stringify(on.body))
    assert.deepStrictEqual(on.body.state.files[0].pinned, [text])
    assert.strictEqual(on.body.pinned, true)

    const st = await call(ctx, 'GET', '/state')
    assert.deepStrictEqual(st.body.files[0].pinned, [text], JSON.stringify(st.body.files[0]))

    const off = await call(ctx, 'POST', '/pin', { file: 'USER.md', text, pinned: false })
    assert.strictEqual(off.status, 200)
    assert.deepStrictEqual(off.body.state.files[0].pinned, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('腾位记录：/evicted 能查到底顶了什么、为什么', async () => {
  const dir = tmpTightMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/config', { limits: { 'MEMORY.md': 130 } })
    await call(ctx, 'POST', '/write', {
      target: 'memory',
      action: 'add',
      content: '丁：qqbot 插件日志在 C:\\Users\\Yk\\.dsh\\qqbot.log',
    })
    const r = await call(ctx, 'GET', '/evicted')
    assert.strictEqual(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.count >= 1)
    assert.ok(r.body.items[0].reason, '要写清淘汰原因：' + JSON.stringify(r.body.items[0]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

