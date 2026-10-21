/**
 * selfcheck.mjs —— 装完自己验一遍，不用开 DSH 界面。
 *
 *   node selfcheck.mjs                      # 验真实记忆目录（只读端点 + 临时目录跑写测试）
 *   node selfcheck.mjs D:\some\memories     # 指定目录
 *
 * 干的事：用真实插件代码起一个临时 HTTP 服务，把面板要用的每个端点打一遍，
 * 报 PASS / FAIL。这样「重启后能不能用」在重启之前就有答案。
 *
 * 写类端点只在临时目录里跑，绝不碰你真实的两份记忆文件。
 */

import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from './index.js'
import { createRequire } from 'node:module'

// 先同步加载一次：插件是按同步模块加载的，模块顶层出现 await 会被判定成异步模块，
// 整个插件不装载 —— apply() 一次都不会被调用，也不报可读错误（2026-10-21 就是栽在这）。
try {
  const req = createRequire(import.meta.url)
  const m = req('./index.js')
  console.log(`✓ 模块可同步加载（无顶层 await）｜inject = ${JSON.stringify(m.inject)}`)
} catch (e) {
  console.error('✗ 模块无法同步加载 —— 检查 index.js 顶层有没有 await：', e.message.split('\n')[0])
  process.exit(1)
}

const realDir = process.argv[2] || path.join(os.homedir(), '.dsh', 'memories')
const BASE = '/api/memory-inject'

let routeSpec = null
const ctx = {
  on() {},
  effect(fn) {
    fn()
  },
  logger: { info() {}, warn() {}, error() {} },
  tools: { register() {} },
  webServer: {
    register(spec) {
      routeSpec = spec
    },
  },
  // 真 cordis 的契约：读服务属性走 ctx.get()，等依赖就绪用 ctx.inject()。
  // 自检里所有服务当场都在，所以 inject 直接同步回调。
  get(name) {
    return ctx[name]
  },
  inject(deps, cb) {
    cb(ctx)
    return null
  },
}

apply(ctx, { memoryDir: realDir })
if (!routeSpec) {
  console.error('✗ 插件没注册 HTTP 路由 —— 检查 inject 里的 webServer')
  process.exit(1)
}

const server = createServer((req, res) => {
  Promise.resolve(routeSpec.handler(req, res)).catch(() => {
    try {
      res.writeHead(500)
      res.end('{"ok":false}')
    } catch {
      /* 已断 */
    }
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const url = (p) => `http://127.0.0.1:${port}${BASE}${p}`

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? '　→ ' + extra : ''}`)
  }
}

async function get(p) {
  const r = await fetch(url(p))
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function post(p, body) {
  const r = await fetch(url(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

console.log(`\n[真实目录] ${realDir}`)
const st = await get('/state')
check('GET /state', st.status === 200 && st.body?.ok === true, JSON.stringify(st.body)?.slice(0, 120))
check('  └ 返回版本号', Boolean(st.body?.version), st.body?.version)
check('  └ 声明路由清单', Array.isArray(st.body?.routes) && st.body.routes.length > 0)
check('  └ 两份文件都在', (st.body?.files || []).length === 2)

const need = ['capture', 'backups', 'restore', 'session', 'similar', 'export', 'import', 'reindex', 'sessions', 'search']
const missing = need.filter((r) => !(st.body?.routes || []).includes(r))
check('  └ 面板要的能力全在', missing.length === 0, missing.join(','))

const ex = await get('/export')
check('GET /export', ex.status === 200 && ex.body?.ok === true)

const bk = await get('/backups?file=USER.md')
check('GET /backups', bk.status === 200 && Array.isArray(bk.body?.backups), JSON.stringify(bk.body)?.slice(0, 80))

const se = await get('/search?q=' + encodeURIComponent('记忆'))
check('GET /search（无索引也能给可读结果）', se.status === 200 && typeof se.body?.ok === 'boolean')

const ss = await get('/sessions?limit=3')
check('GET /sessions', ss.status === 200 && typeof ss.body?.ok === 'boolean', ss.body?.error)

const sim = await get('/similar?file=MEMORY.md&text=' + encodeURIComponent('改配置前先备份'))
check('GET /similar', sim.status === 200 && Array.isArray(sim.body?.similar))

const cap = await post('/capture', {})
check(
  'POST /capture（没轮次时应报可读错误，不是 404）',
  cap.status === 400 || cap.status === 502,
  `HTTP ${cap.status}`,
)

const unknown = await get('/nope')
check('未知路由 404', unknown.status === 404)

// ── 写类端点：只在临时目录里跑，不碰真实记忆 ──
console.log('\n[临时目录] 写类端点隔离测试')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'memselfcheck-'))
writeFileSync(path.join(tmp, 'USER.md'), '原有条目\n', 'utf-8')
writeFileSync(path.join(tmp, 'MEMORY.md'), '环境条目\n', 'utf-8')
const tmpRoute = { spec: null }
const tmpCtx = {
  on() {},
  effect(fn) {
    fn()
  },
  logger: { info() {}, warn() {}, error() {} },
  tools: { register() {} },
  webServer: {
    register(spec) {
      tmpRoute.spec = spec
    },
  },
  get(name) {
    return tmpCtx[name]
  },
  inject(deps, cb) {
    cb(tmpCtx)
    return null
  },
}
apply(tmpCtx, { memoryDir: tmp })

const tmpServer = createServer((req, res) => {
  Promise.resolve(tmpRoute.spec.handler(req, res)).catch(() => {
    try {
      res.writeHead(500)
      res.end('{"ok":false}')
    } catch {
      /* 已断 */
    }
  })
})
await new Promise((r) => tmpServer.listen(0, '127.0.0.1', r))
const tport = tmpServer.address().port
const turl = (p) => `http://127.0.0.1:${tport}${BASE}${p}`
const tpost = async (p, b) => {
  const r = await fetch(turl(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b || {}),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

const w = await tpost('/write', { target: 'user', action: 'set', entries: ['甲', '乙'] })
check('POST /write 整份覆盖', w.status === 200 && w.body?.ok === true, JSON.stringify(w.body)?.slice(0, 120))

const cfg = await tpost('/config', { limits: { 'USER.md': 5000 } })
check('POST /config 改上限', cfg.status === 200 && cfg.body?.state?.files?.[0]?.maxChars === 5000)

const b2 = await tpost('/restore', { file: 'USER.md', name: '../../etc/passwd' })
check('POST /restore 拦截路径穿越', b2.status === 400 && b2.body?.ok === false)

const im = await tpost('/import', { data: { files: [{ name: 'USER.md', entries: ['甲', '丙'] }] }, mode: 'merge' })
check('POST /import 合并', im.status === 200 && im.body?.report?.[0]?.added === 1, JSON.stringify(im.body)?.slice(0, 120))

const b3 = (await fetch(turl('/backups?file=USER.md')).then((r) => r.json())).backups || []
check('写操作产生了备份', b3.length >= 1)

if (b3.length > 0) {
  const r2 = await tpost('/restore', { file: 'USER.md', name: b3[0].name })
  check('POST /restore 恢复', r2.status === 200 && r2.body?.ok === true, JSON.stringify(r2.body)?.slice(0, 120))
}

server.close()
tmpServer.close()
rmSync(tmp, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
