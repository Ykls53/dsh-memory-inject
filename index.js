/**
 * dsh-memory-inject — 把 USER.md / MEMORY.md 当固定记忆注入 DSH 会话
 *
 * 解决的问题
 *   DSH 的记忆插件（memsearch 那类）是「语义检索」：要先搜、命中才注入，
 *   存的是原文流水账。真正让人「记得住」的是另一种东西——一小份结论型事实，
 *   每个会话开头就摆在模型面前，不用搜。
 *
 *   这个插件就干这一件事：会话开始时把两份短清单注入上下文。
 *     - USER.md  用户是谁、怎么说话、偏好与反感
 *     - MEMORY.md 环境事实：路径、端口、坑、命令
 *   格式都是「一行一条，条目之间单独一行 §」（跟 Hermes Agent 的惯例一致）。
 *
 * 注入时机与去重
 *   挂在 `agent/pre-step`（每轮第一步模型调用之前）。
 *   注入后会带 source.kind = "plugin:dsh-memory-inject" 的标记，
 *   下一轮先检查历史里有没有这条标记：有就跳过，没有才补。
 *   这样既不会每轮重复堆积，又能在上下文被压缩掉之后自动补回来。
 *
 * 没有依赖：只用 node 内置模块，读不到文件就静默跳过（插件永不拖垮会话）。
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  copyFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { readStore, writeStore, patchStore, batchStore, DELIM } from './lib/store.mjs'

// Node 22.5+ 内置 sqlite；查记忆索引靠它，省掉一个 python 依赖。拿不到就只关掉检索能力。
let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

const PLUGIN_NAME = 'dsh-memory-inject'
const SOURCE_KIND = `plugin:${PLUGIN_NAME}`

/** 需要的 DSH 服务；只声明真正用到的，缺了会被框架拦在 apply 之前。 */
export const inject = ['agents', 'tools', 'webServer']

const DEFAULTS = {
  // 记忆目录；默认 ~/.dsh/memories
  memoryDir: path.join(os.homedir(), '.dsh', 'memories'),
  // 注哪些文件，顺序即注入顺序；maxChars 是每个文件自己的硬预算
  files: [
    { name: 'USER.md', heading: 'USER PROFILE (who the user is)', maxChars: 1375 },
    { name: 'MEMORY.md', heading: 'MEMORY (your personal notes)', maxChars: 2200 },
  ],
  // 注入内容总预算（字符）。超了就按文件顺序截，防把上下文吃穿。
  maxTotalChars: 4000,
  // 只在这些 turn 上注入；空数组 = 每个 turn 都检查（靠 source 标记去重）
  turns: [],
  // 注入时是否打这行说明；关掉只留正文
  includePreamble: true,
  // 全自动回填：一轮结束就提炼事实写回文件。用 DSH 当前模型，零配置。
  autoCapture: false,
  // 提炼子进程超时（毫秒）
  captureTimeoutMs: 180000,
}

const PREAMBLE =
  '[System note: 以下是你的持久记忆，来自跨会话累积的事实清单，不是新的用户输入。' +
  '把它们当作既有事实直接采用：不要向用户复述「我记得……」，也不要因为它们而改变当前任务的判断。]'

/** 把配置规整成可用的形态，坏值一律退回默认，绝不抛错。 */
function normalizeConfig(config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  if (typeof cfg.memoryDir !== 'string' || !cfg.memoryDir.trim()) cfg.memoryDir = DEFAULTS.memoryDir
  if (!Array.isArray(cfg.files) || cfg.files.length === 0) cfg.files = DEFAULTS.files
  const max = Number(cfg.maxTotalChars)
  cfg.maxTotalChars = Number.isFinite(max) && max > 0 ? max : DEFAULTS.maxTotalChars
  cfg.turns = Array.isArray(cfg.turns) ? cfg.turns.filter((n) => Number.isInteger(n)) : []
  cfg.includePreamble = cfg.includePreamble !== false
  return cfg
}

/**
 * 读一份记忆文件。
 * 返回 null 表示「没有可用内容」——文件不存在、读不了、或者只有空白。
 * 这里刻意不抛错：记忆是锦上添花的东西，它出问题不该让会话崩掉。
 */
function readMemoryFile(dir, file) {
  const target = path.join(dir, file.name)
  try {
    if (!existsSync(target)) return null
    const raw = readFileSync(target, 'utf-8')
    const text = raw.trim()
    if (!text) return null
    return { heading: file.heading || file.name, text }
  } catch {
    return null
  }
}

/**
 * 拼出要注入的整块文本，并守住字符预算。
 * 预算策略：逐个文件累加，超了就整文件跳过（不切半句，切半句比不注入更糟）。
 */
function buildBlock(cfg) {
  const parts = []
  for (const file of cfg.files) {
    const got = readMemoryFile(cfg.memoryDir, file)
    if (!got) continue
    const section = `## ${got.heading}\n${got.text}`
    const used = parts.reduce((n, p) => n + p.length, 0)
    if (used + section.length > cfg.maxTotalChars) continue
    parts.push(section)
  }
  if (parts.length === 0) return null
  const body = parts.join('\n\n')
  return cfg.includePreamble ? `${PREAMBLE}\n\n${body}` : body
}

/** 历史里是否已经有本插件注入的那条（压缩掉之后会返回 false，于是补注入）。 */
function alreadyInjected(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((m) => m && m.source && m.source.kind === SOURCE_KIND)
}

/** 造一条注入消息；优先用 dsh-llm 的工厂，拿不到就手搓同形状对象。 */
async function makeMemoryMessage(ctx, text) {
  const source = {
    kind: SOURCE_KIND,
    form: 'snapshot',
    sections: [{ name: 'memory', text }],
  }
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    const factory = mod?.createUserMessage || mod?.default?.createUserMessage
    if (typeof factory === 'function') {
      return factory({ content: [{ type: 'text', text }], source })
    }
  } catch {
    // 没有 dsh-llm 就直接走下面的兜底，不影响功能
  }
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  })
}

/**
 * 插件入口。
 * @param ctx Cordis 插件上下文
 * @param config 见 DEFAULTS
 */
export function apply(ctx, config = {}) {
  // 自动回填会 spawn 一个 headless agent，它也会装载本插件。
  // 见到这个标记就直接退出，否则提炼出来的会话又被抓一遍，无限循环。
  if (process.env[AUTO_ENV] === '1') return

  const cfg = normalizeConfig(config)
  // 面板里改过的开关存在 .settings.json，优先级高于 cordis.patch.yml
  const local = readLocalSettings(cfg.memoryDir)
  if (typeof local.autoCapture === 'boolean') cfg.autoCapture = local.autoCapture
  let warnedEmpty = false

  ctx.on(
    'agent/pre-step',
    async (event, next) => {
      const decision = await next()
      // 被拒的轮次不碰；中断的不碰
      if (!decision || decision.kind === 'reject') return decision
      if (event?.signal?.aborted) return decision
      // 只处理第一步：一轮里后续步骤不该再挂钩子
      const step = event?.step
      if (step !== undefined && step !== 1) return decision
      // 配了 turns 白名单就只在这些 turn 注入
      const turn = event?.turn
      if (cfg.turns.length > 0 && !cfg.turns.includes(turn)) return decision
      // 已经在历史里就不重复注入
      if (alreadyInjected(decision.messages)) return decision

      const text = buildBlock(cfg)
      if (!text) {
        if (!warnedEmpty) {
          warnedEmpty = true
          ctx.logger?.info?.(
            `[${PLUGIN_NAME}] ${cfg.memoryDir} 下没有可注入的记忆文件，本次跳过`,
          )
        }
        return decision
      }

      const message = await makeMemoryMessage(ctx, text)
      return {
        ...decision,
        kind: 'enter',
        messages: [...(decision.messages || []), message],
      }
    },
    { prepend: true },
  )

  ctx.logger?.info?.(`[${PLUGIN_NAME}] 已装载，记忆目录 ${cfg.memoryDir}`)

  // L2/L3：把「查过去」做成工具，模型能自己搜，不用等人喂
  registerSearchTool(ctx, cfg)

  // 写入：让模型能主动记（等价 Hermes 的 memory 工具）
  registerWriteTool(ctx, cfg)

  // 全自动：一轮结束后提炼事实写回文件
  applyAutoCapture(ctx, cfg)

  // 设置面板的接口
  registerHttp(ctx, cfg)
}

// ─────────────────────────────────────────────────────────────────────
// L2/L3 检索：让模型能自己问「上周三聊了什么」
//
// L2 = 每个会话的摘要（session_summaries 表）
// L3 = 全量原文（chunks + FTS5 trigram 索引）
// 两个都在同一个 index.db 里，由配套脚本生成（见 README）。
// ─────────────────────────────────────────────────────────────────────

const INDEX_FILE = 'index.db'

function openIndex(dir) {
  if (!DatabaseSync) return { error: '当前 Node 没有内置 sqlite（需要 22.5+），检索不可用' }
  const file = path.join(dir, INDEX_FILE)
  if (!existsSync(file)) {
    return { error: `没有索引库 ${file}。先跑配套脚本生成索引，工具才有东西可查。` }
  }
  try {
    return { db: new DatabaseSync(file, { readOnly: true }) }
  } catch (e) {
    return { error: `打不开索引库：${e.message}` }
  }
}

/** "7d" / "24h" / "2w" → 毫秒时间戳下界；认不出就返回 null。 */
function parseAfter(v) {
  if (!v) return null
  const m = /^(\d+)\s*([hdw])$/i.exec(String(v).trim())
  if (!m) return null
  const unit = { h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()]
  return Date.now() - Number(m[1]) * unit * 1000
}

function fmtTime(ms) {
  if (!ms) return '?'
  try {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
  } catch {
    return '?'
  }
}

/**
 * 在索引库里检索。
 * FTS5 trigram 负责中文精确匹配；查询里出现 FTS 语法字符时降级成 LIKE。
 * 结果按会话聚合——用户问「聊了什么」，要的是「哪个会话」，不是「哪一句话」。
 */
function searchMemory(dir, { query, after, limit } = {}) {
  const { db, error } = openIndex(dir)
  if (error) return { ok: false, error }

  const q = String(query || '').trim()
  if (!q) {
    db.close?.()
    return { ok: false, error: 'query 不能为空' }
  }
  const k = Math.max(1, Math.min(Number(limit) || 5, 20))
  const afterMs = parseAfter(after)

  let rows = []
  try {
    rows = db
      .prepare(
        `select c.session_id, c.role, c.ts, c.text, bm25(chunks_fts) as rank
         from chunks_fts join chunks c on c.id = chunks_fts.rowid
         where chunks_fts match ?
         order by rank limit 400`,
      )
      .all(q.replace(/"/g, '""'))
  } catch {
    rows = []
  }
  if (rows.length === 0) {
    try {
      rows = db
        .prepare(
          `select session_id, role, ts, text, 0 as rank from chunks
           where text like ? order by ts desc limit 400`,
        )
        .all(`%${q}%`)
    } catch {
      rows = []
    }
  }
  if (afterMs) rows = rows.filter((r) => (r.ts || 0) >= afterMs)

  // 每个会话只留最佳命中（rank 更小 = 更相关；同分取更新）
  const best = new Map()
  for (const r of rows) {
    const cur = best.get(r.session_id)
    if (!cur || r.rank < cur.rank || (r.rank === cur.rank && (r.ts || 0) > (cur.ts || 0))) {
      best.set(r.session_id, r)
    }
  }

  const hits = [...best.values()]
    .sort((a, b) => a.rank - b.rank || (b.ts || 0) - (a.ts || 0))
    .slice(0, k)
    .map((row) => {
      let meta = {}
      let summary = null
      try {
        meta =
          db.prepare('select title, project, created_at from sessions where id = ?').get(row.session_id) ||
          {}
      } catch {
        /* 表结构可能不同，忽略 */
      }
      try {
        const s = db.prepare('select summary from session_summaries where session_id = ?').get(row.session_id)
        summary = s?.summary || null
      } catch {
        /* 没摘要表也照常返回原文命中 */
      }
      const text = String(row.text || '')
      const idx = text.indexOf(q)
      const snippet =
        idx >= 0
          ? '…' + text.slice(Math.max(0, idx - 80), idx + 220)
          : text.slice(0, 260)
      return {
        session: row.session_id,
        title: meta.title || '(无标题)',
        project: meta.project || '',
        created: fmtTime(meta.created_at),
        matched_at: fmtTime(row.ts),
        role: row.role,
        snippet: snippet.replace(/\s+/g, ' '),
        summary,
      }
    })

  db.close?.()
  return { ok: true, query: q, count: hits.length, hits }
}

/** 拿宿主的 defineTool；拿不到就用一个等价物（DSH 的 register 直接收 spec）。 */
async function resolveDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    const fn = mod?.defineTool || mod?.default?.defineTool
    if (typeof fn === 'function') return fn
  } catch {
    /* 宿主没暴露这个包，走下面的等价实现 */
  }
  return (spec) => spec
}

/** 把 memory_search 注册成模型可调用的工具。失败了只记日志，不影响注入。 */
function registerSearchTool(ctx, cfg) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    ctx.logger?.warn?.(`[${PLUGIN_NAME}] 没有 tools 服务，memory_search 未注册`)
    return
  }
  resolveDefineTool()
    .then((defineTool) => {
      const spec = {
        name: 'memory_search',
        description:
          '搜过去的会话记忆（全量原文 + 每会话摘要），按会话聚合返回。' +
          '当用户问「上周三聊了什么」「之前那个方案最后定的啥」「那个坑怎么解的」这类跨会话回忆时用它，' +
          '不要凭印象猜。返回：会话标题、创建时间、命中片段、该会话的摘要。',
        parameters: {
          query: { type: 'string', description: '关键词或短句，中文直接写（中文按三元组索引匹配，很准）' },
          after: { type: 'string', description: '只搜最近这段：7d / 24h / 2w。不填 = 全部历史' },
          limit: { type: 'number', description: '返回几个会话，默认 5' },
        },
        async execute(args) {
          return searchMemory(cfg.memoryDir, {
            query: args?.query,
            after: args?.after,
            limit: args?.limit,
          })
        },
      }
      try {
        ctx.tools.register(defineTool(spec))
        ctx.logger?.info?.(`[${PLUGIN_NAME}] memory_search 已注册`)
      } catch (e) {
        ctx.logger?.warn?.(`[${PLUGIN_NAME}] memory_search 注册失败：${e.message}`)
      }
    })
    .catch((e) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] memory_search 初始化失败：${e.message}`))
}

// ─────────────────────────────────────────────────────────────────────
// 写入：memory_remember —— 让模型主动记（等价 Hermes 的 memory 工具）
// ─────────────────────────────────────────────────────────────────────

const TARGET_FILE = { user: 'USER.md', memory: 'MEMORY.md' }

/**
 * 某份文件当前生效的字符上限。
 * 优先级：面板里改过的（.settings.json 的 limits）> cordis.patch.yml 的 files[].maxChars > 默认。
 * 上限是用户的东西，不该被代码写死。
 */
function maxCharsOf(cfg, file) {
  const base = cfg.files.find((f) => f.name === file)?.maxChars ?? 2200
  const override = readLocalSettings(cfg.memoryDir)?.limits?.[file]
  return Number.isFinite(override) && override > 0 ? override : base
}

/** 统一写入口；工具和自动回填共用，保证预算口径一致。 */
function writeMemory(cfg, { target, action, content, oldText, newText, operations, entries } = {}) {
  const file = TARGET_FILE[target] || 'MEMORY.md'
  const opts = { maxChars: maxCharsOf(cfg, file) }
  const dir = cfg.memoryDir

  if (action === 'add') {
    if (!content) return { ok: false, error: 'add 需要 content' }
    return { ...batchStore(dir, file, { add: [content] }, opts), file }
  }
  if (action === 'remove') {
    if (!oldText) return { ok: false, error: 'remove 需要 oldText' }
    return { ...batchStore(dir, file, { remove: [oldText] }, opts), file }
  }
  if (action === 'replace') {
    if (!oldText || newText === undefined) {
      return { ok: false, error: 'replace 需要 oldText + newText' }
    }
    return { ...patchStore(dir, file, { oldText, newText }, opts), file }
  }
  if (action === 'batch') {
    return { ...batchStore(dir, file, operations || {}, opts), file }
  }
  if (action === 'set') {
    // 整份覆盖：给面板用（人看得见整张清单，改完一次提交）
    return { ...writeStore(dir, file, Array.isArray(entries) ? entries : [], opts), file }
  }
  return { ok: false, error: `未知 action：${action}（add｜remove｜replace｜batch）` }
}

function registerWriteTool(ctx, cfg) {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') return
  resolveDefineTool()
    .then((defineTool) => {
      const spec = {
        name: 'memory_remember',
        description:
          '往持久记忆里写/改/删条目。写进去的事实会在每个新会话开头自动注入，所以只写「值得长期记住」的：稳定的偏好、环境里的坑、结论性事实。' +
          '别写流水账（那是会话档案的事）。一条只讲一件事。超出该文件预算会被拒（不截断、不偷偷丢），这时用 batch 先删旧的再加新的。',
        parameters: {
          target: {
            type: 'string',
            description: "'user' = 用户画像（USER.md，预算 1375 字符）｜'memory' = 环境笔记（MEMORY.md，预算 2200 字符）",
          },
          action: {
            type: 'string',
            description: 'add（加一条）｜remove（删一条，给 oldText）｜replace（改一条，给 oldText+newText）｜batch（一次删+加，预算只看最终结果）',
          },
          content: { type: 'string', description: 'add 时的条目正文：一句话，只讲一件事' },
          oldText: { type: 'string', description: 'remove / replace 要匹配的文字（必须唯一命中，否则拒绝）' },
          newText: { type: 'string', description: 'replace 时替换成什么' },
          operations: {
            type: 'object',
            description: 'batch 的操作：{ remove: [文字], add: [条目], replace: [{ oldText, newText }] }',
          },
        },
        async execute(args) {
          const res = writeMemory(cfg, args || {})
          return res.ok
            ? { ...res, note: '已写盘。当前会话已注入过的那份快照不变，下次开新会话才读到新的。' }
            : res
        },
      }
      try {
        ctx.tools.register(defineTool(spec))
        ctx.logger?.info?.(`[${PLUGIN_NAME}] memory_remember 已注册`)
      } catch (e) {
        ctx.logger?.warn?.(`[${PLUGIN_NAME}] memory_remember 注册失败：${e.message}`)
      }
    })
    .catch(() => {})
}

// ─────────────────────────────────────────────────────────────────────
// 全自动回填：一轮结束 → 用 DSH 当前模型提炼 → 写回文件
//
// 模型来源：spawn `dsh --profile headless`，它读 ~/.dsh/settings.yaml 的
// agent-default-model —— 就是 Web UI 模型选择器写的那个。所以用户换 OAI
// 就 OAI 提炼、换别的就别的提炼，插件不需要知道 key。
//
// 递归保护：子进程带 DSH_MEMORY_INJECT_SUMMARIZE=1，apply() 见到就直接退出，
// 免得提炼出来的会话又被抓一遍。
// ─────────────────────────────────────────────────────────────────────

const AUTO_ENV = 'DSH_MEMORY_INJECT_SUMMARIZE'
const CAPTURE_MAX_CHARS = 6000

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (typeof c === 'string') return c
      if (c?.type === 'text') return c.text || ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 从这一轮的事件里抠出「用户说了啥 / 助手答了啥 / 调了哪些工具」。 */
function renderTurnForCapture(session, turnEndEvent) {
  const turn = turnEndEvent?.data?.turn
  if (turn === undefined) return null

  let events
  try {
    events =
      typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
  } catch {
    events = session?.events
  }
  if (!Array.isArray(events) || events.length === 0) return null

  const endIdx = events.findIndex((e) => e?.type === 'turn/end' && e?.data?.turn === turn)
  if (endIdx < 0) return null
  let startIdx = -1
  for (let i = endIdx - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start' && events[i]?.data?.turn === turn) {
      startIdx = i
      break
    }
  }
  if (startIdx < 0) return null

  const lines = []
  let hasUser = false
  for (const e of events.slice(startIdx + 1, endIdx)) {
    if (e?.type === 'user/message') {
      if (e.data?.source?.kind !== 'user') continue
      const t = textFromContent(e.data?.content)
      if (!t) continue
      lines.push(`[User]: ${t}`)
      hasUser = true
    } else if (e?.type === 'assistant/message') {
      const t = textFromContent(e.data?.message?.content)
      if (t) lines.push(`[Assistant]: ${t}`)
    } else if (e?.type === 'tool/call' && e.data?.name) {
      lines.push(`[Tool]: ${e.data.name}`)
    }
  }
  if (!hasUser) return null
  const body = lines.join('\n').trim()
  return body.length > 20 ? body.slice(0, CAPTURE_MAX_CHARS) : null
}

const EXTRACT_PROMPT = (body) => `你在给一个长期记忆系统做提炼。下面是刚结束的一轮对话，请挑出「值得长期记住」的事实。

按行输出，每行必须以 USER: 或 ENV: 开头：
- USER: 关于用户本人的稳定事实（称呼、偏好、反感、说话方式、长期在做的事）。一次性的请求不算。
- ENV: 环境事实（路径、端口、配置规律、踩过的坑与解法、反复用到的命令）。一次性的操作过程不算。

规矩：
1. 一条只讲一件事，一句话讲完；不要编号、不要客套、不要解释。
2. 必须能从对话里直接看出，不许推测。
3. 没有值得记的就只输出一行：NONE
4. 别抄原文长句，压成结论。

对话：
---
${body}
---

输出：`

/** 跑一次 headless agent 做提炼；失败一律返回 null，不抛。 */
function runHeadlessExtract(prompt, cfg) {
  return new Promise((resolve) => {
    const cmd = process.env.DSH_CLI || 'dsh'
    let out = ''
    let child
    try {
      child = spawn(cmd, ['--profile', 'headless', prompt], {
        cwd: cfg.memoryDir,
        env: { ...process.env, [AUTO_ENV]: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32', // dsh 在 Windows 上是 .cmd
        windowsHide: true,
      })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      resolve(null)
    }, cfg.captureTimeoutMs)
    child.stdout?.on('data', (d) => {
      out += d
    })
    child.stderr?.on('data', () => {}) // 错误信息不用，失败就当没有
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.trim() || null)
    })
  })
}

/** 把提炼结果解析成两类条目。 */
function parseExtract(text) {
  const user = []
  const env = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^NONE$/i.test(line)) continue
    const m = /^(USER|ENV)\s*[:：]\s*(.+)$/i.exec(line)
    if (!m) continue
    const item = m[2].trim()
    if (item.length < 4) continue
    ;(m[1].toUpperCase() === 'USER' ? user : env).push(item)
  }
  return { user, env }
}

/** 把提炼出的条目写回对应文件；预算满了就先跳过并记日志（不擅自删旧的）。 */
function persistExtract(ctx, cfg, { user, env }) {
  const done = { user: 0, env: 0, skipped: [] }
  for (const [items, target] of [
    [user, 'user'],
    [env, 'memory'],
  ]) {
    for (const item of items) {
      const res = writeMemory(cfg, { target, action: 'add', content: item })
      if (res.ok) {
        if (res.applied?.added) done[target === 'user' ? 'user' : 'env'] += 1
      } else {
        done.skipped.push(`${target}: ${String(res.error).slice(0, 80)}`)
      }
    }
  }
  if (done.skipped.length) {
    ctx.logger?.warn?.(
      `[${PLUGIN_NAME}] 自动回填有 ${done.skipped.length} 条没写进去（预算或匹配失败）：${done.skipped[0]}`,
    )
  }
  if (done.user + done.env > 0) {
    ctx.logger?.info?.(`[${PLUGIN_NAME}] 自动回填：USER ${done.user} 条 / ENV ${done.env} 条`)
  }
}

/** 最近一轮的引用：自动回填关着的时候，面板里的「现在提炼」也用它。 */
let lastTurnRef = null

function applyAutoCapture(ctx, cfg) {
  let running = false

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    lastTurnRef = { session, event } // 不管开关，都留着备用
    if (!cfg.autoCapture) return
    if (running) return // 上一轮的提炼还没完，跳过这一轮，不排队堆积

    const body = renderTurnForCapture(session, event)
    if (!body) return

    running = true
    runHeadlessExtract(EXTRACT_PROMPT(body), cfg)
      .then((text) => {
        if (!text) return
        const parsed = parseExtract(text)
        if (parsed.user.length === 0 && parsed.env.length === 0) return
        persistExtract(ctx, cfg, parsed)
      })
      .catch((e) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] 自动回填失败：${e.message}`))
      .finally(() => {
        running = false
      })
  })
}

// ─────────────────────────────────────────────────────────────────────
// 设置面板的服务端：读写记忆条目 + 开关自动回填
//
// 配置持久化：面板改的开关不写回 cordis.patch.yml（那是静态 patch），
// 而是落到 <memoryDir>/.settings.json，apply() 时读它覆盖。
// ─────────────────────────────────────────────────────────────────────

const SETTINGS_FILE = '.settings.json'

function readLocalSettings(dir) {
  try {
    const p = path.join(dir, SETTINGS_FILE)
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) || {}
  } catch {
    return {}
  }
}

function writeLocalSettings(dir, patchObj) {
  const cur = readLocalSettings(dir)
  const next = { ...cur, ...patchObj }
  try {
    mkdirp(dir)
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(next, null, 2), 'utf-8')
    return { ok: true, settings: next }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function mkdirp(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 已存在 */
  }
}

function sendJson(res, status, payload) {
  try {
    res.writeHead?.(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end?.(JSON.stringify(payload))
  } catch {
    /* 连接已断 */
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on?.('data', (c) => {
      raw += c
      if (raw.length > 200_000) raw = raw.slice(0, 200_000) // 面板不会传这么大，防一手
    })
    req.on?.('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on?.('error', () => resolve({}))
  })
}

function statePayload(cfg) {
  return {
    ok: true,
    autoCapture: cfg.autoCapture !== false,
    memoryDir: cfg.memoryDir,
    modelNote: '自动回填用的是 DSH 当前模型（settings.yaml 的 agent-default-model），你在模型选择器里换它跟着换',
    files: cfg.files.map((f) => {
      const st = readStore(cfg.memoryDir, f.name)
      const body = st.entries.join(DELIM)
      return {
        name: f.name,
        heading: f.heading,
        // 给的是「当前生效」的上限：面板改过就是改过的那个
        maxChars: maxCharsOf(cfg, f.name),
        chars: body.trim().length,
        entries: st.entries,
      }
    }),
  }
}

// ── 面板用的辅助能力：回滚 / 下钻 / 相似检测 / 导入导出 / 重建索引 ──

/** 某份文件的备份清单（新的在前）。 */
function listBackups(dir, file) {
  const bdir = path.join(dir, '.backup')
  if (!existsSync(bdir)) return []
  try {
    return readdirSync(bdir)
      .filter((f) => f.startsWith(file + '.bak-'))
      .map((f) => {
        const st = statSync(path.join(bdir, f))
        const stampRaw = f.slice((file + '.bak-').length).replace(/-/g, '')
        const y = stampRaw.slice(0, 4)
        const mo = stampRaw.slice(4, 6)
        const d = stampRaw.slice(6, 8)
        const hh = stampRaw.slice(9, 11)
        const mm = stampRaw.slice(11, 13)
        const ss = stampRaw.slice(13, 15)
        return {
          name: f,
          time: st.mtimeMs,
          size: st.size,
          label: `${y}-${mo}-${d} ${hh}:${mm}:${ss}`,
        }
      })
      .sort((a, b) => b.time - a.time)
  } catch {
    return []
  }
}

/** 从备份恢复一份文件。只接受本目录里、同前缀的备份名（防路径穿越）。 */
function restoreBackup(dir, file, name) {
  if (typeof name !== 'string' || !name.startsWith(file + '.bak-')) {
    return { ok: false, error: '备份名不合法（必须属于这个文件）' }
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return { ok: false, error: '备份名里不能有路径分隔符' }
  }
  const src = path.join(dir, '.backup', name)
  if (!existsSync(src)) return { ok: false, error: '这个备份不存在了' }
  try {
    // 恢复前先把当前内容也备份一份，免得恢复错了回不去
    const cur = path.join(dir, file)
    if (existsSync(cur)) {
      const bdir = path.join(dir, '.backup')
      mkdirSync(bdir, { recursive: true })
      const now = new Date()
      const p = (n) => String(n).padStart(2, '0')
      copyFileSync(
        cur,
        path.join(
          bdir,
          `${file}.bak-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`,
        ),
      )
    }
    copyFileSync(src, cur)
    const after = readStore(dir, file)
    return { ok: true, restored: name, entries: after.entries.length, chars: after.entries.join(DELIM).length }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 某个会话的完整对话（第 3 层下钻）。 */
function sessionDetail(cfg, id) {
  if (!id) return { ok: false, error: '缺 session id' }
  const { db, error } = openIndex(cfg.memoryDir)
  if (error) return { ok: false, error }
  try {
    const meta =
      db.prepare('select title, created_at, project, msg_count from sessions where id = ?').get(id) || {}
    let summary = null
    try {
      summary = db.prepare('select summary from session_summaries where session_id = ?').get(id)?.summary || null
    } catch {
      /* 没摘要表 */
    }
    const rows = db
      .prepare(
        `select role, ts, text from chunks
         where session_id = ? and kind = 'msg'
         order by coalesce(ts, 0), id limit 400`,
      )
      .all(id)
    return {
      ok: true,
      id,
      title: meta.title || '(无标题)',
      project: meta.project || '',
      created: fmtTime(meta.created_at),
      msgs: meta.msg_count || rows.length,
      summary,
      messages: rows.map((r) => ({ role: r.role, time: fmtTime(r.ts), text: r.text })),
    }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    db.close?.()
  }
}

/**
 * 相似条目检测：加一条之前先看看有没有「换个说法但意思一样」的。
 * 用双字组重合度（中文没有空格分词，双字组够用且快），不引入任何依赖。
 */
function findSimilar(dir, file, text) {
  const target = String(text || '').trim()
  if (target.length < 4) return []
  const norm = (s) =>
    String(s)
      .replace(/\s+/g, '')
      .replace(/[，。、；：""''（）()《》【】!?！？,.;:]/g, '')
  const bigrams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }
  const a = bigrams(norm(target))
  if (a.size === 0) return []
  const out = []
  for (const e of readStore(dir, file).entries) {
    const b = bigrams(norm(e))
    if (b.size === 0) continue
    let inter = 0
    for (const g of a) if (b.has(g)) inter += 1
    const ratio = inter / Math.max(1, Math.min(a.size, b.size))
    if (ratio >= 0.5) out.push({ entry: e, ratio: Math.round(ratio * 100) })
  }
  return out.sort((x, y) => y.ratio - x.ratio).slice(0, 5)
}

/** 整库导出（换机器 / 备份 / 贴给别人）。 */
function exportAll(cfg) {
  return {
    ok: true,
    version: 1,
    exportedAt: new Date().toISOString(),
    memoryDir: cfg.memoryDir,
    files: cfg.files.map((f) => ({ name: f.name, entries: readStore(cfg.memoryDir, f.name).entries })),
  }
}

/** 整库导入：merge = 只加没有的（去重）；replace = 整份覆盖。 */
function importAll(cfg, data, mode = 'merge') {
  if (!data || !Array.isArray(data.files)) return { ok: false, error: '数据格式不对（要 { files: [...] }）' }
  const report = []
  for (const item of data.files) {
    const file = cfg.files.find((f) => f.name === item?.name)?.name
    if (!file) {
      report.push({ file: item?.name || '?', skipped: '不认识的记忆文件' })
      continue
    }
    const incoming = Array.isArray(item.entries) ? item.entries.filter((e) => typeof e === 'string' && e.trim()) : []
    if (mode === 'replace') {
      const res = writeMemory(cfg, { target: TARGET_FILE.user === file ? 'user' : 'memory', action: 'set', entries: incoming })
      report.push({ file, ok: res.ok, mode: 'replace', count: incoming.length, error: res.error })
    } else {
      const cur = readStore(cfg.memoryDir, file).entries
      const add = incoming.filter((e) => !cur.includes(e.trim()))
      const res = writeMemory(cfg, {
        target: TARGET_FILE.user === file ? 'user' : 'memory',
        action: 'set',
        entries: [...cur, ...add],
      })
      report.push({ file, ok: res.ok, mode: 'merge', added: add.length, error: res.error })
    }
  }
  return { ok: true, report }
}

/** 重建索引：先跑 dump（node，自带），再跑 index（python，有就跑）。 */
function reindex(cfg) {
  return new Promise((resolve) => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const dumpScript = path.join(here, 'scripts', 'dsh-memory-dump.mjs')
    const indexPath = path.join(here, 'scripts', 'dsh-memory-index.py')
    const log = []

    const run = (cmd, args, timeoutMs = 180000) =>
      new Promise((res) => {
        let out = ''
        let child
        try {
          child = spawn(cmd, args, {
            cwd: cfg.memoryDir,
            env: { ...process.env, [AUTO_ENV]: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: true,
          })
        } catch (e) {
          return res({ ok: false, error: e.message })
        }
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* 已退出 */
          }
          res({ ok: false, error: '超时' })
        }, timeoutMs)
        child.stdout?.on('data', (d) => {
          out += d
        })
        child.stderr?.on('data', (d) => {
          out += d
        })
        child.on('error', (e) => {
          clearTimeout(timer)
          res({ ok: false, error: e.message })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          res({ ok: code === 0, code, tail: out.trim().split(/\r?\n/).slice(-6).join('\n') })
        })
      })

    ;(async () => {
      if (!existsSync(dumpScript)) {
        log.push('没有 scripts/dsh-memory-dump.mjs，跳过 dump')
      } else {
        const r = await run(process.execPath, [dumpScript])
        log.push(`dump：${r.ok ? '成功' : '失败 ' + (r.error || r.code)}${r.tail ? '\n' + r.tail : ''}`)
      }
      if (!existsSync(indexPath)) {
        log.push('没有 scripts/dsh-memory-index.py，跳过建索引')
      } else {
        const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
        const r = await run(py, [indexPath, 'build'])
        log.push(`index：${r.ok ? '成功' : '失败（没装 python？）' + (r.error || r.code)}${r.tail ? '\n' + r.tail : ''}`)
      }
      resolve({ ok: true, log: log.join('\n\n') })
    })()
  })
}

function listSessions(cfg, limit = 50) {
  const { db, error } = openIndex(cfg.memoryDir)
  if (error) return { ok: false, error }
  try {
    const rows = db
      .prepare(
        `select s.id, s.title, s.project, s.created_at, s.msg_count, x.summary
         from sessions s left join session_summaries x on x.session_id = s.id
         order by s.created_at desc limit ?`,
      )
      .all(Math.max(1, Math.min(Number(limit) || 50, 300)))
    const total = db.prepare('select count(*) c from sessions').get()?.c ?? rows.length
    const withSummary = db.prepare('select count(*) c from session_summaries').get()?.c ?? 0
    return {
      ok: true,
      total,
      withSummary,
      sessions: rows.map((r) => ({
        id: r.id,
        title: r.title || '(无标题)',
        project: r.project || '',
        created: fmtTime(r.created_at),
        msgs: r.msg_count || 0,
        summary: r.summary || null,
      })),
    }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    db.close?.()
  }
}

function registerHttp(ctx, cfg) {
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
    ctx.logger?.warn?.(`[${PLUGIN_NAME}] 没有 webServer 服务，设置面板的接口没挂上`)
    return
  }
  const base = '/api/memory-inject'

  ctx.effect?.(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: base,
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1')
          const route = url.pathname.slice(base.length) || '/'
          try {
            if (req.method === 'GET' && route === '/state') {
              return sendJson(res, 200, statePayload(cfg))
            }
            // 中期记忆：最近会话 + 摘要（面板里的「会话摘要」页）
            if (req.method === 'GET' && route === '/sessions') {
              return sendJson(res, 200, listSessions(cfg, Number(url.searchParams.get('limit')) || 50))
            }
            // 面板里的搜索框，和模型用的 memory_search 同一套逻辑
            if (req.method === 'GET' && route === '/search') {
              return sendJson(
                res,
                200,
                searchMemory(cfg.memoryDir, {
                  query: url.searchParams.get('q') || '',
                  after: url.searchParams.get('after') || undefined,
                  limit: Number(url.searchParams.get('limit')) || 5,
                }),
              )
            }
            if (req.method === 'POST' && route === '/write') {
              const body = await readJsonBody(req)
              const res1 = writeMemory(cfg, body)
              return sendJson(res, res1.ok ? 200 : 400, {
                ...res1,
                state: res1.ok ? statePayload(cfg) : undefined,
              })
            }
            if (req.method === 'POST' && route === '/config') {
              const body = await readJsonBody(req)
              const patchObj = {}
              if (typeof body.autoCapture === 'boolean') {
                patchObj.autoCapture = body.autoCapture
                cfg.autoCapture = body.autoCapture // 立刻生效，不用重启
              }
              // 上限可改：{ limits: { 'USER.md': 4000 } } —— 逐文件合并，不互相覆盖
              if (body.limits && typeof body.limits === 'object') {
                const cur = readLocalSettings(cfg.memoryDir)?.limits || {}
                const merged = { ...cur, ...body.limits }
                for (const [k, v] of Object.entries(merged)) {
                  const n = Number(v)
                  if (Number.isFinite(n) && n > 0) merged[k] = Math.round(n)
                  else delete merged[k]
                }
                patchObj.limits = merged
              }
              const saved = writeLocalSettings(cfg.memoryDir, patchObj)
              return sendJson(res, saved.ok ? 200 : 500, {
                ...saved,
                autoCapture: cfg.autoCapture,
                state: saved.ok ? statePayload(cfg) : undefined,
              })
            }
            // 最近一轮手动提炼（自动开关关着也能用）
            if (req.method === 'POST' && route === '/capture') {
              if (!lastTurnRef) {
                return sendJson(res, 400, { ok: false, error: '还没抓到可提炼的一轮 —— 先聊一轮再来' })
              }
              const body = renderTurnForCapture(lastTurnRef.session, lastTurnRef.event)
              if (!body) return sendJson(res, 400, { ok: false, error: '这一轮没有可提炼的内容' })
              const text = await runHeadlessExtract(EXTRACT_PROMPT(body), cfg)
              if (!text) {
                return sendJson(res, 502, { ok: false, error: '提炼没返回 —— headless agent 起不来，或模型没回话' })
              }
              const parsed = parseExtract(text)
              persistExtract(ctx, cfg, parsed)
              return sendJson(res, 200, { ok: true, ...parsed, state: statePayload(cfg) })
            }

            // 备份清单 / 恢复
            if (req.method === 'GET' && route === '/backups') {
              const file = url.searchParams.get('file') || 'MEMORY.md'
              return sendJson(res, 200, { ok: true, file, backups: listBackups(cfg.memoryDir, file) })
            }
            if (req.method === 'POST' && route === '/restore') {
              const body = await readJsonBody(req)
              const file = body.file === 'USER.md' ? 'USER.md' : 'MEMORY.md'
              const r = restoreBackup(cfg.memoryDir, file, body.name)
              return sendJson(res, r.ok ? 200 : 400, { ...r, state: r.ok ? statePayload(cfg) : undefined })
            }

            // 第 3 层下钻：某个会话的完整对话
            if (req.method === 'GET' && route === '/session') {
              return sendJson(res, 200, sessionDetail(cfg, url.searchParams.get('id')))
            }

            // 加条目前的相似检测
            if (req.method === 'GET' && route === '/similar') {
              const file = url.searchParams.get('file') === 'USER.md' ? 'USER.md' : 'MEMORY.md'
              return sendJson(res, 200, {
                ok: true,
                file,
                similar: findSimilar(cfg.memoryDir, file, url.searchParams.get('text') || ''),
              })
            }

            // 导出 / 导入
            if (req.method === 'GET' && route === '/export') {
              return sendJson(res, 200, exportAll(cfg))
            }
            if (req.method === 'POST' && route === '/import') {
              const body = await readJsonBody(req)
              const r = importAll(cfg, body.data, body.mode === 'replace' ? 'replace' : 'merge')
              return sendJson(res, r.ok ? 200 : 400, { ...r, state: r.ok ? statePayload(cfg) : undefined })
            }

            // 重建索引（dump + build）
            if (req.method === 'POST' && route === '/reindex') {
              const r = await reindex(cfg)
              return sendJson(res, 200, r)
            }

            return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${route}` })
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
          }
        },
      }),
    `${PLUGIN_NAME}: ${base} 路由`,
  )
  ctx.logger?.info?.(`[${PLUGIN_NAME}] 面板接口已挂 ${base}`)
}

export default { apply, inject }
