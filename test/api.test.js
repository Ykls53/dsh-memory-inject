/**
 * 接口级测试：模拟 DSH 的 HTTP 调用，把面板用到的每个端点都走一遍。
 * 这是最容易藏 bug 的地方（路由拼错、方法写错、JSON 结构对不上），必须真调。
 *
 * 跑法：node --test test/api.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply } from '../index.js'

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
        /* effect 里的注册失败不该影响测试 */
      }
    },
  }
  ctx.tools = { register: (spec) => ctx.registeredTools.push(spec) }
  ctx.webServer = {
    register: (spec) => {
      ctx.route = spec
    },
  }
  // 真 cordis 的 ctx：读服务属性要走 ctx.get()，等依赖就绪要用 ctx.inject()。
  // 这里用假 ctx 模拟同样的契约 —— inject 里的服务当场都在，所以同步回调即可。
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

async function call(ctx, method, route, payload) {
  const spec = ctx.route
  assert.ok(spec, '路由没注册上')
  const res = makeRes()
  await spec.handler(makeReq(method, BASE + route, payload), res)
  return res
}

function tmpMemory(entries = { 'USER.md': ['用户喜欢简短回答'], 'MEMORY.md': ['端口 8080'] }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'memapi-'))
  for (const [name, list] of Object.entries(entries)) {
    writeFileSync(path.join(dir, name), list.join('\n§\n') + '\n', 'utf-8')
  }
  return dir
}

/** 造一个真实结构的 index.db，让 /sessions、/search、/session 有东西可查。 */
function seedIndex(dir) {
  const db = new DatabaseSync(path.join(dir, 'index.db'))
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, cwd TEXT, preset TEXT,
      created_at INTEGER, title TEXT, first_user TEXT, last_reply TEXT, msg_count INTEGER);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, kind TEXT, ts INTEGER, text TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');
    CREATE TABLE session_summaries (session_id TEXT PRIMARY KEY, summary TEXT, model TEXT, created_at INTEGER);
  `)
  const now = Date.now()
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)').run(
    's1', 'proj', null, null, now, '端口冲突那天', '', '', 2,
  )
  db.prepare('INSERT INTO chunks (id,session_id,role,kind,ts,text) VALUES (?,?,?,?,?,?)').run(
    1, 's1', 'user', 'msg', now, '上周三我们聊了端口冲突的事',
  )
  db.prepare('INSERT INTO chunks (id,session_id,role,kind,ts,text) VALUES (?,?,?,?,?,?)').run(
    2, 's1', 'assistant', 'msg', now, '结论是改成 8080',
  )
  db.prepare('INSERT INTO session_summaries VALUES (?,?,?,?)').run('s1', '这是一个测试会话的摘要', null, now)
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
  db.close()
}

function boot(dir) {
  const ctx = makeCtx()
  apply(ctx, { memoryDir: dir })
  return ctx
}

test('GET /state：返回两份文件和生效上限', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'GET', '/state')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.ok, true)
    assert.strictEqual(r.body.files.length, 2)
    assert.strictEqual(r.body.files[0].name, 'USER.md')
    assert.ok(r.body.files[0].maxChars > 0)
    assert.strictEqual(r.body.autoCapture, false, '默认应当是关的')
    // 版本 + 能力声明：面板靠这两个字段判断「后端是不是旧代码」
    assert.ok(r.body.version, '/state 必须返回插件版本')
    assert.ok(Array.isArray(r.body.routes), '/state 必须返回路由清单')
    for (const need of ['capture', 'backups', 'restore', 'reindex', 'export', 'import']) {
      assert.ok(r.body.routes.includes(need), `routes 里缺 ${need}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两个工具都注册上了', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await new Promise((r) => setTimeout(r, 30)) // 工具是异步注册的
    const names = ctx.registeredTools.map((t) => t.name)
    assert.ok(names.includes('memory_search'), 'memory_search 没注册：' + names.join(','))
    assert.ok(names.includes('memory_remember'), 'memory_remember 没注册：' + names.join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /write：整份覆盖并返回最新 state', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'POST', '/write', {
      target: 'user',
      action: 'set',
      entries: ['甲', '乙'],
    })
    assert.strictEqual(r.status, 200, JSON.stringify(r.body))
    assert.strictEqual(r.body.ok, true)
    assert.strictEqual(r.body.entries.length, 2)
    assert.ok(r.body.state, '应当回带 state 给面板刷新')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /write：超上限被拒，且不落盘', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/config', { limits: { 'USER.md': 20 } })
    const r = await call(ctx, 'POST', '/write', { target: 'user', action: 'set', entries: ['x'.repeat(50)] })
    assert.strictEqual(r.status, 400)
    assert.strictEqual(r.body.ok, false)
    assert.match(r.body.error, /超预算/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /config：上限改了立刻在 /state 里生效', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const before = (await call(ctx, 'GET', '/state')).body.files[0].maxChars
    await call(ctx, 'POST', '/config', { limits: { 'USER.md': 9999 } })
    const after = (await call(ctx, 'GET', '/state')).body.files[0].maxChars
    assert.strictEqual(after, 9999)
    assert.notStrictEqual(before, after)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /backups + POST /restore：能列出并恢复', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    await call(ctx, 'POST', '/write', { target: 'user', action: 'set', entries: ['新内容'] })
    const b = await call(ctx, 'GET', '/backups?file=USER.md')
    assert.strictEqual(b.status, 200)
    assert.ok(b.body.backups.length >= 1, '写一次之后应当有备份')

    const target = b.body.backups[0].name
    const r = await call(ctx, 'POST', '/restore', { file: 'USER.md', name: target })
    assert.strictEqual(r.status, 200, JSON.stringify(r.body))
    assert.strictEqual(r.body.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /restore：非法备份名被拒（防路径穿越）', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'POST', '/restore', { file: 'USER.md', name: '../../secret.txt' })
    assert.strictEqual(r.status, 400)
    assert.strictEqual(r.body.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /similar：找出重合度高的已有条目', async () => {
  const dir = tmpMemory({ 'MEMORY.md': ['改配置前先备份再重启', '端口是 8080'] })
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'GET', '/similar?file=MEMORY.md&text=' + encodeURIComponent('改配置前要先备份再重启'))
    assert.strictEqual(r.status, 200)
    assert.ok(r.body.similar.length >= 1, '应当认出重复意思的那条')
    assert.ok(r.body.similar[0].ratio >= 50)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /export + POST /import：导出后合并导入', async () => {
  const dir = tmpMemory({ 'USER.md': ['原有的一条'] })
  try {
    const ctx = boot(dir)
    const ex = await call(ctx, 'GET', '/export')
    assert.strictEqual(ex.status, 200)
    assert.strictEqual(ex.body.files.length, 2)

    const payload = {
      ok: true,
      files: [{ name: 'USER.md', entries: ['原有的一条', '导入的一条'] }],
    }
    const im = await call(ctx, 'POST', '/import', { data: payload, mode: 'merge' })
    assert.strictEqual(im.status, 200, JSON.stringify(im.body))
    assert.strictEqual(im.body.report[0].added, 1, '重复的那条不该再加一遍')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /sessions：中期记忆列表', async () => {
  const dir = tmpMemory()
  try {
    seedIndex(dir)
    const ctx = boot(dir)
    const r = await call(ctx, 'GET', '/sessions?limit=10')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.ok, true)
    assert.strictEqual(r.body.total, 1)
    assert.strictEqual(r.body.withSummary, 1)
    assert.strictEqual(r.body.sessions[0].title, '端口冲突那天')
    assert.match(r.body.sessions[0].summary, /测试会话/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /search：中文命中（trigram）', async () => {
  const dir = tmpMemory()
  try {
    seedIndex(dir)
    const ctx = boot(dir)
    const r = await call(ctx, 'GET', '/search?q=' + encodeURIComponent('端口冲突'))
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.ok, true)
    assert.ok(r.body.count >= 1, '应当命中那个会话')
    assert.strictEqual(r.body.hits[0].session, 's1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /session：下钻拿完整对话', async () => {
  const dir = tmpMemory()
  try {
    seedIndex(dir)
    const ctx = boot(dir)
    const r = await call(ctx, 'GET', '/session?id=s1')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.ok, true)
    assert.strictEqual(r.body.messages.length, 2)
    assert.match(r.body.messages[0].text, /端口冲突/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /session：不存在的会话返回空而不是崩', async () => {
  const dir = tmpMemory()
  try {
    seedIndex(dir)
    const ctx = boot(dir)
    const r = await call(ctx, 'GET', '/session?id=nope')
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.ok, true)
    assert.strictEqual(r.body.messages.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有 index.db 时，检索类接口给出可读错误而不是抛异常', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const s = await call(ctx, 'GET', '/search?q=测试')
    assert.strictEqual(s.status, 200)
    assert.strictEqual(s.body.ok, false)
    assert.match(s.body.error, /索引|index/)
    const ls = await call(ctx, 'GET', '/sessions')
    assert.strictEqual(ls.body.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /capture：没抓到轮次时明确报错，不崩', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'POST', '/capture', {})
    assert.strictEqual(r.status, 400)
    assert.strictEqual(r.body.ok, false)
    assert.match(r.body.error, /还没抓到/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未知路由返回 404 JSON', async () => {
  const dir = tmpMemory()
  try {
    const ctx = boot(dir)
    const r = await call(ctx, 'GET', '/nope')
    assert.strictEqual(r.status, 404)
    assert.strictEqual(r.body.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
