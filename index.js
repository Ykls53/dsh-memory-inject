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
  unlinkSync,
  rmSync,
} from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { readStore, writeStore, patchStore, batchStore, parseEntries, DELIM } from './lib/store.mjs'

// Node 22.5+ 内置 sqlite；查记忆索引靠它，省掉一个 python 依赖。拿不到就只关掉检索能力。
//
// ⚠️ 这里必须是【同步】require，不能写 `await import(...)`。
// 插件是按同步模块加载的：模块顶层出现 await 会被判定成异步模块，直接加载失败，
// 连 apply() 都不会被调用 —— 现象是整个插件消失（注入没了、面板没了），
// 而且不报任何可读错误。2026-10-21 就栽在这一行上。
let DatabaseSync = null
try {
  const requireSync = createRequire(import.meta.url)
  ;({ DatabaseSync } = requireSync('node:sqlite'))
} catch {
  DatabaseSync = null
}

const PLUGIN_NAME = 'dsh-memory-inject'

/**
 * 装载观测（诊断用，成本几乎为零）。
 * DSH 桌面端没有可读的启动日志，插件不加载时完全静默 —— 只能让它自己写下来：
 *   .load.log 里出现「模块已加载」     → 插件被 loader 取到了，问题在 apply 之后
 *   .load.log 里出现「apply 被调用」   → 进了 apply，看它后面的服务状态
 *   两行都没有                        → 插件根本没被 loader 取到（安装/登记问题）
 */
function _probe(msg) {
  try {
    const dir = path.join(os.homedir(), '.dsh', 'memories')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.load.log'), `[${new Date().toISOString()}] ${msg}\n`, {
      flag: 'a',
    })
  } catch {
    /* 观测失败不影响主流程 */
  }
}

_probe('index.js 模块已加载')

/** 插件版本：从自己的 package.json 读，面板拿它判断「后端是不是旧代码」。 */
const PLUGIN_VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf-8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
const SOURCE_KIND = `plugin:${PLUGIN_NAME}`

/**
 * 插件 id —— **必须导出**，且要和 cordis.patch.yml 里 insert 的 `id` 一致。
 * 不导出它，cordis 无法把模块和 profile 里那条插件行对上：
 * 模块会被 import（顶层代码照跑、探针会写日志），但 apply() 永远不被调用 ——
 * 现象是「设置里能看见面板，接口全 not found」。2026-10-21 卡了一整天的最后一个坑。
 */
export const name = 'memory-inject'

/**
 * 需要的 DSH 服务。
 *
 * cordis 的语义是「声明的服务**全部就绪**才把 fiber 从 PENDING 推到 ACTIVE，才调用 apply」。
 * 换句话说：inject 里写了一个拿不到的名字 = apply 永远不执行，而且完全静默
 * （模块顶层照跑、探针只有「模块已加载」一行，现象和「插件没被加载」一模一样）。
 * 这是 2026-10-21～22 卡了两天、重启快十次的根因。
 *
 * 重要：cordis 的 inject 是**硬依赖**，没有「有就用」这种软依赖写法。
 * 所以这里只用空数组 + 运行时手动取服务，见 apply 里的 ctx.get('webServer')。
 *
 * ⚠️ 别再把它改回 ['webServer']：桌面端的 webServer 服务在插件 ctx 里拿不到，
 *    写上去就会把整个插件（含记忆注入）一起卡死在 PENDING。
 *    要恢复硬依赖，先在 diagnostics 里确认 `ctx.get('webServer')` 真的返回对象。
 */
export const inject = []

export const DEFAULTS = {
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
  /**
   * 跳过这些 agent preset 的会话（2026-10-22 加）。
   *
   * 为什么需要：QQ 机器人（`im-qqbot`）跟桌面端跑在**同一个进程**里，
   * 而 `agent/pre-step` 是全局钩子 —— 不给过滤条件的话，主人自己的 USER.md / MEMORY.md
   * 会被塞进 QQ 聊天里（对方是别人，不该看到这些）。
   *
   * 判据来自 `agent.session.header.agentPreset`：session 的 header 里存着这个会话用的 preset id。
   * 但 pre-step 事件本身拿不到 agent —— 所以靠 `system-prompt/assemble`（同一 turn 里
   * 先于 pre-step 触发，带 `context.agent`）把 preset 记下来，pre-step 再比对。
   *
   * 写成 `[]` 就恢复「所有会话都注入」的旧行为。
   */
  skipPresets: ['qqbot', 'qqbot-c2c'],
  // 只在这些 preset 上注入；空数组 = 不限（跟 skipPresets 同时配时，白名单优先）
  onlyPresets: [],
  // 全自动回填：一轮结束就提炼事实写回文件。用 DSH 当前模型，零配置。
  autoCapture: false,
  // 提炼子进程超时（毫秒）
  captureTimeoutMs: 180000,
  /**
   * 这些工作目录的会话**不参与提炼**（2026-10-28 加）。
   *
   * 为什么：QQ 机器人、B站值守跟桌面端跑在同一个宿主里，它们的每轮对话也会触发
   * turn/end。不拦的话，机器人在群里的规矩、别人问的话会被当成「主人的稳定事实」
   * 写进 USER.md —— 实测已经混进去过「用户被称作主人」「只回复自己的 @」这类
   * 机器人守则，那是机器人语境，不是主人的画像。
   * 记忆目录自己也拦：提炼子会话被再提炼会写出「提炼 prompt」这种自指垃圾。
   *
   * 匹配方式：cwd 小写、反斜杠统一后做子串匹配（写成 `['\\qqbot']` 即可）。
   * 空数组 = 不拦（旧行为）。
   */
  skipCaptureCwds: ['\\qqbot', 'bili-duty', '.dsh\\memories'],
  /**
   * 提炼走 HTTP 直调（2026-10-28 加），省掉「每次 spawn 一个 headless 会话」：
   *   旧路：`dsh --profile headless` → 每提炼一次就在 ~/.dsh/sessions 落一个会话目录
   *         （实测堆到 479 个），还要冷启动 3~20 秒、吃进 8.6k 字符的 AGENTS.md。
   *   新路：直接打 opencode-go 的 /chat/completions，输入只剩「提炼要求 + 本轮正文」。
   * HTTP 拿不到结果时自动回退 headless，且回退前后对比目录、把新落的会话删掉。
   * 这三个字段留空就只用 headless（想彻底回退旧行为就清空 apiKeyEnv）。
   */
  extractBaseURL: 'https://opencode.ai/zen/go/v1',
  // 提炼模型走哪条 provider 路由（空 = 用旧路 HTTP 直调 opencode-go）
  extractProvider: '',
  extractModel: 'deepseek-v4.1-flash',
  extractApiKeyEnv: 'OPENCODE_API_KEY',
  // 单次 HTTP 提炼超时（毫秒）
  extractHttpTimeoutMs: 90000,
  /**
   * 做梦通道（2026-11-14 加）：跨会话离线整理已有记忆。
   *
   * 与提炼回填分工不同：提炼是从「新会话」里采集新事实，做梦是拿历史转录
   * 当地面真相，核对/纠正/合并/删改「已有的」第 1 层记忆（对齐 Anthropic
   * 《The components of agent memory》里的 dreaming）。
   *
   * 模型选择照刷B站插件的套路：provider + model 双字段，留空跟随提炼通道。
   *   - dreamModelProvider: 'opencode-go'（HTTP 直调）/ 'headless'（走 headless 会话）/ ''（auto：先 HTTP 再回退 headless）
   *   - dreamModelName: 留空 = 跟提炼通道同一个模型（即 extractModel）；填了就覆盖
   *   - provider 填不认的值时忽略并跟随提炼通道，记日志标注（跟刷B站插件的 ignored 标注一致）
   */
  dreamModelProvider: '',
  dreamModelName: '',
  // 喂给做梦的转录片段总预算（字符），防 prompt 被撑爆
  dreamSnippetChars: 6000,
  /**
   * 表征层（wiki）—— 2026-11-14 加。
   * 文章实测：纯搜索 53%，搜索 + wiki 61%，还省 token。wiki 是记忆地图。
   * 但文章也警告顶层必须小，所以 wiki 正文**不进注入**，
   * 注入里只带一份极小的主题索引，细看靠 memory_wiki 工具取整页。
   */
  wikiIndex: true,
  wikiIndexChars: 600,
  /**
   * 自动重建索引（2026-11-14 加）：每天第一次启动时自动跑一次 dump + build。
   * 为什么：重建要扫全部会话转录、耗时几分钟，以前得点按钮；
   * 但索引过时会让搜索和做梦都拿到旧数据，所以改成「每天第一次启动时后台跑一次」。
   * 手动按钮保留（随时能强制重建）。
   */
  autoReindex: true,
  /** 两次自动重建的最小间隔（小时）；默认 24 = 每天最多一次。 */
  autoReindexHours: 24,
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
  // preset 白/黑名单：只留字符串，去重
  const pick = (v) =>
    Array.isArray(v) ? [...new Set(v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))] : []
  cfg.skipPresets = pick(cfg.skipPresets)
  cfg.onlyPresets = pick(cfg.onlyPresets)
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
  const injectedEntries = []
  for (const file of cfg.files) {
    const got = readMemoryFile(cfg.memoryDir, file)
    if (!got) continue
    const section = `## ${got.heading}\n${got.text}`
    const used = parts.reduce((n, p) => n + p.length, 0)
    if (used + section.length > cfg.maxTotalChars) continue
    parts.push(section)
    // 记下这次真正注入出去的条目，供使用统计
    for (const e of parseEntries(got.text)) injectedEntries.push(e)
  }
  // wiki 索引（小）放在最后，独立预算；超总预算就整块不要，绝不挤掉主记忆
  if (cfg.wikiIndex !== false) {
    const wiki = buildWikiIndexBlock(cfg, Number(cfg.wikiIndexChars) || 600)
    if (wiki) {
      const used = parts.reduce((n, p) => n + p.length, 0)
      if (used + wiki.length <= cfg.maxTotalChars) parts.push(wiki)
    }
  }
  if (parts.length === 0) return null
  const body = parts.join('\n\n')
  // 使用统计：注入一次就记一次（对齐文章「按访问频率调做梦节奏」）
  try {
    recordInjected(cfg.memoryDir, injectedEntries)
  } catch {
    /* 统计失败不影响注入 */
  }
  return cfg.includePreamble ? `${PREAMBLE}\n\n${body}` : body
}

/** 内容指纹：注入文本的 sha1 短哈希。文件改了指纹就变，用于会话级「没变不注入」。 */
function hashText(text) {
  return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16)
}

/**
 * 从会话历史里找本插件注入过的消息，返回它的指纹。
 * - 返回 null：历史里没有（首次 / 被压缩掉）→ 该补注入；
 * - 返回 ''：有注入消息但没有指纹（旧版消息）→ 也补注入；
 * - 返回指纹串：和当前内容比，一样就不注入。
 * 拿不到 agent / session 时返回 null，由会话级缓存兜底。
 */
function injectedFingerprintInSession(agent) {
  try {
    const nodes = agent?.session?.surface?.nodes
    if (!nodes || typeof nodes.toReversed !== 'function') return null
    for (const seq of nodes.toReversed()) {
      const ev = agent.session.eventAt(seq)
      if (ev?.type === 'user/message' && ev.data?.source?.kind === SOURCE_KIND) {
        return ev.data.source.baselineIdentity || ''
      }
    }
  } catch {
    /* 拿不到就当没有 */
  }
  return null
}

/** 造一条注入消息；优先用 dsh-llm 的工厂，拿不到就手搓同形状对象。 */
async function makeMemoryMessage(ctx, text, fingerprint) {
  const source = {
    kind: SOURCE_KIND,
    form: 'snapshot',
    baseline: true,
    baselineIdentity: fingerprint || '',
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
  // 探针 2：证明 apply 真的被调用了（放在 env 判断之前，否则被 return 掉就什么都看不到）。
  // 同时打出守卫变量的实际值 —— 如果它确实是 '1'，apply 会在下面静默返回，
  // 现象和「apply 没被调用」一模一样。2026-10-22 加的。
  _probe(
    `apply 被调用（进函数第一行）｜AUTO_ENV=${JSON.stringify(process.env.DSH_MEMORY_INJECT_SUMMARIZE)}`,
  )

  // 自动回填会 spawn 一个 headless agent，它也会装载本插件。
  // 见到这个标记就直接退出，否则提炼出来的会话又被抓一遍，无限循环。
  if (process.env[AUTO_ENV] === '1') return

  // ⚠️ 取服务一律用 ctx.get(name)，**不能写 ctx.webServer**：
  //    cordis 的 ctx 是代理，访问一个没在 inject 里声明的属性会直接抛
  //    `Error: cannot get property "webServer" without inject` —— 连探针自己都会炸。
  //    ctx.get() 走 reflect，取不到就返回 undefined，安全。2026-10-22 踩到。
  const svc = (n) => {
    try {
      return ctx?.get?.(n)
    } catch {
      return undefined
    }
  }
  _probe(
    `apply 被调用｜服务：webServer=${!!svc('webServer')} tools=${!!svc('tools')} ` +
      `agents=${!!svc('agents')} settings=${!!svc('settings')} effect=${typeof ctx?.effect} ` +
      `logger=${typeof ctx?.logger} config=${JSON.stringify(config)}`,
  )

  const cfg = normalizeConfig(config)
  // 面板里改过的开关存在 .settings.json，优先级高于 cordis.patch.yml
  try {
    const local = readLocalSettings(cfg.memoryDir)
    if (typeof local.autoCapture === 'boolean') cfg.autoCapture = local.autoCapture
    // 模型选择（2026-11-14 加）：面板手动选的模型覆盖配置文件里的
    if (typeof local.extractProvider === 'string') cfg.extractProvider = local.extractProvider
    if (typeof local.extractModel === 'string' && local.extractModel.trim()) cfg.extractModel = local.extractModel
    if (typeof local.dreamModelProvider === 'string') cfg.dreamModelProvider = local.dreamModelProvider
    if (typeof local.dreamModelName === 'string') cfg.dreamModelName = local.dreamModelName
  } catch {
    /* 读不到就用默认，不该因此不装载 */
  }

  /**
   * 每一块独立兜住。
   * 教训（2026-10-21）：某一项注册失败（比如面板接口的参数不被接受）会让 apply 整个抛错，
   * 结果连「记忆注入」都没了 —— 用户看到的现象是「插件整个失效」，很难联想到是面板的锅。
   * 从今往后：任何一块挂了只记日志，其余照常工作。
   *
   * 日志同时写进 <memoryDir>/.errors.log —— DSH 桌面端没有可读的启动日志，
   * 不落盘的话「哪个块失败了」永远查不到。
   */
  const guard = (name, fn) => {
    try {
      fn()
    } catch (e) {
      ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${name} 初始化失败（其余功能继续）：${e?.message || e}`)
      try {
        mkdirSync(cfg.memoryDir, { recursive: true })
        writeFileSync(
          path.join(cfg.memoryDir, '.errors.log'),
          `[${new Date().toISOString()}] ${name}: ${e?.stack || e}\n`,
          { flag: 'a' },
        )
      } catch {
        /* 落盘也失败就算了 */
      }
    }
  }

  // ── 第一块：注入。这是基本盘，必须先挂上 ──
  let warnedEmpty = false

  /**
   * 记录「这一 turn 是哪个 preset 在跑」。
   *
   * 为什么要绕这一道：`agent/pre-step` 的事件里只有 messages/turn/step/signal，
   * **没有 agent，也没有 session**（cordis 的 dispatch 没传 thisArg，监听器拿不到上下文）。
   * 但 `system-prompt/assemble` 带 `context.agent`，而且它在同一个 turn 里**先于** pre-step 触发
   * （见 dsh-agent-loop 的 preStep：先 await systemPrompt.assemble，再 dispatch agent/pre-step）。
   * 所以在这儿把 preset 记下来，pre-step 紧接着读。
   *
   * 判据是 `agent.session.header.agentPreset` —— session header 里存着这个会话用的 preset id。
   * 时间窗 200ms：两个事件紧邻触发，窗外的旧值一律不认，避免跨会话串台。
   */
  let lastPreset = { value: null, at: 0 }
  let lastSession = { value: null, at: 0 }
  /**
   * 最近一次 assemble 见到的 agent 对象（2026-11-14 加）。
   *
   * 为什么需要：`agent/pre-step` 的事件里**没有 agent**（只有 messages/turn/step/signal），
   * 所以 event.agent 永远是 undefined，`injectedFingerprintInSession` 永远返回 null，
   * 只能靠 sessionId 缓存兜底。而 sessionId 原来只在 200ms 窗内认，
   * 一旦 pre-step 跟 assemble 隔得久一点就取不到 → 每轮都注入。
   *
   * 修法：assemble 里把 agent 也存下来，pre-step 时用「最新那个 agent」去查会话历史。
   * agent 对象本身带 session，查到的历史就是这个会话的真实历史，比缓存可靠。
   */
  let lastAgent = { value: null, at: 0 }
  // 会话级指纹缓存：sessionId → 已注入的指纹。同一会话内指纹没变就不注入，
  // 根治「每轮都注入」（pre-step 的 messages 只含本轮认领消息，不含历史，
  // 所以不能靠查决策消息里的旧基线来判断，必须自己记）。
  const injectedFps = new Map()
  guard('preset 探针', () => {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      try {
        const agent = context?.agent
        const header = agent?.session?.header
        const preset = header?.agentPreset
        const sid = header?.id
        lastPreset = { value: typeof preset === 'string' ? preset : null, at: Date.now() }
        lastSession = { value: typeof sid === 'string' ? sid : null, at: Date.now() }
        if (agent?.session) lastAgent = { value: agent, at: Date.now() }
      } catch {
        /* 拿不到就当没这回事，不影响组装 */
      }
      return next()
    })
  })

  /** 当前 turn 的 preset 是否该被排除。 */
  const presetExcluded = () => {
    if (cfg.onlyPresets.length === 0 && cfg.skipPresets.length === 0) return false
    const fresh = Date.now() - lastPreset.at < 200
    const preset = fresh ? lastPreset.value : null
    // 白名单优先：配了 onlyPresets 就只在名单里注入
    if (cfg.onlyPresets.length > 0) {
      if (preset === null) return false // 读不出来就按原行为放行，宁可多注入也别误伤
      return !cfg.onlyPresets.includes(preset)
    }
    if (preset === null) return false
    return cfg.skipPresets.includes(preset)
  }

  /**
   * 当前会话的 sessionId。
   * 2026-11-14 改：原来只认 200ms 内的新鲜值，pre-step 稍晚一点就取不到 → 每轮重复注入。
   * 改成「优先新鲜值、拿不到就用最近一次见过的」。
   * sessionId 只用于区分「是不是同一个会话」，退回旧值最多让判断偏一次，
   * 比每轮都注入的代价小得多。preset 那边仍保留严格 200ms 窗口（它直接影响注不注入）。
   */
  const freshSessionId = () => lastSession.value || null

  guard('注入钩子', () => {
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
        // 这个 preset 被排除了（比如 QQ 机器人）就不注入
        if (presetExcluded()) return decision
        // 没有可注入内容就跳过
        const text = buildBlock(cfg)
        if (!text) {
          if (!warnedEmpty) {
            warnedEmpty = true
            ctx.logger?.info?.(`[${PLUGIN_NAME}] ${cfg.memoryDir} 下没有可注入的记忆文件，本次跳过`)
          }
          return decision
        }

        // 会话级判断（取代「每轮无脑注入」）：
        //   pre-step 的 messages 只含本轮认领的消息、不含历史（inbox.claim），
        //   所以要么查 agent 的会话历史，要么自己按 sessionId 记指纹。
        //   历史里已有同指纹 → 不注入（不重复堆）；历史里没有（首次/被压缩）→ 补注入；
        //   指纹变了（内容改了）→ 注入新基线（最新内容在场）。
        const fingerprint = hashText(text)
        // agent 从两个地方取：事件自带（新宿主）或 assemble 里缓存的（老宿主没有 event.agent）
        const agent = event?.agent?.session?.surface ? event.agent : (Date.now() - lastAgent.at < 60000 ? lastAgent.value : null)
        const histFp = injectedFingerprintInSession(agent)
        const sid = freshSessionId() || (agent?.session?.header?.id ?? null)
        if (histFp !== null) {
          // 能查到会话历史就以它为准：同指纹不注入，变了/被压缩了就注入
          if (histFp === fingerprint) {
            if (sid) injectedFps.set(sid, fingerprint)
            return decision
          }
        } else if (sid && injectedFps.get(sid) === fingerprint) {
          // 查不到历史（旧宿主/首次）才用会话级缓存兜底
          return decision
        }
        if (sid) injectedFps.set(sid, fingerprint)
        const message = await makeMemoryMessage(ctx, text, fingerprint)
        return {
          ...decision,
          kind: 'enter',
          messages: [...(decision.messages || []), message],
        }
      },
      { prepend: true },
    )
  })

  // ── 其余能力：任何一个挂了都不影响上面的注入 ──
  //
  // 这里**不能**直接调用、也不能光靠 ctx.get()：
  // 实测（2026-10-22）本插件 apply 时 webServer / tools 还没就绪，
  // 4 秒后 bili-scroll 才拿到它们 —— 服务是「晚一步」提供的。
  //
  // 正确姿势是 ctx.inject(deps, cb)：cordis 会把 cb 挂起，等这些服务**全部就绪**
  // 才调用它（dsh-api-gateway / dsh-client-connection 都是这么写的）。
  // 好处：主 apply 不被阻塞（记忆注入立刻生效），接口和工具等就绪后自动挂上。
  const whenReady = (deps, label, fn) => {
    guard(label, () => {
      if (typeof ctx?.inject !== 'function') {
        // 极老版本的 cordis 没有 ctx.inject，退化成当场试一次
        _probe(`[${label}] 没有 ctx.inject，退化成立即调用`)
        fn(ctx)
        return
      }
      _probe(`[${label}] 登记 ctx.inject(${JSON.stringify(deps)})`)
      ctx.inject(deps, (sub) => {
        // 回调触发 = 这些服务真的就绪了（cordis 保证）
        _probe(`[${label}] ctx.inject 回调触发｜服务=${typeof sub?.get === 'function' ? deps.map((d) => `${d}=${!!sub.get(d)}`).join(' ') : 'no-get'}`)
        try {
          fn(sub)
          _probe(`[${label}] 挂载完成`)
        } catch (e) {
          _probe(`[${label}] 挂载失败：${e?.message || e}`)
          ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${label} 挂载失败（其余功能继续）：${e?.message || e}`)
        }
      })
    })
  }

  whenReady(['tools'], 'memory_search 工具', (c) => registerSearchTool(c, cfg))
  whenReady(['tools'], 'memory_wiki 工具', (c) => registerWikiTool(c, cfg))
  whenReady(['tools'], 'memory_remember 工具', (c) => registerWriteTool(c, cfg))
  guard('自动回填', () => applyAutoCapture(ctx, cfg))
  guard('自动重建索引', () => scheduleAutoReindex(ctx, cfg))
  whenReady(['webServer'], '面板接口', (c) => registerHttp(c, cfg))

  _probe('apply 完成，全部功能注册走完')
  ctx.logger?.info?.(`[${PLUGIN_NAME}] 已装载，记忆目录 ${cfg.memoryDir}`)
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
  // ctx.get() 而不是 ctx.tools —— 没 inject 时读属性会抛（见 apply 里的说明）。
  const tools = (() => {
    try {
      return ctx?.get?.('tools')
    } catch {
      return undefined
    }
  })()
  if (!tools || typeof tools.register !== 'function') {
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
          const r = searchMemory(cfg.memoryDir, {
            query: args?.query,
            after: args?.after,
            limit: args?.limit,
          })
          // 顺手带出相关 wiki 主题 —— 这就是文章说的「链接」：
          // 搜索命中之后，模型能顺着主题页看全景，而不是只知道零散片段。
          try {
            const topics = relatedWikiTopics(cfg.memoryDir, args?.query)
            if (topics.length) r.relatedWiki = topics.map((t) => t.topic)
          } catch {
            /* 不影响搜索本身 */
          }
          return r
        },
      }
      try {
        tools.register(defineTool(spec))
        ctx.logger?.info?.(`[${PLUGIN_NAME}] memory_search 已注册`)
      } catch (e) {
        ctx.logger?.warn?.(`[${PLUGIN_NAME}] memory_search 注册失败：${e.message}`)
      }
    })
    .catch((e) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] memory_search 初始化失败：${e.message}`))
}

/**
 * memory_wiki —— 取某个 wiki 主题页的全文，或列出全部主题。
 * 这是「记忆地图」的入口：注入里只有一行主题名，模型想知道细节就调它。
 */
function registerWikiTool(ctx, cfg) {
  const tools = (() => {
    try {
      return ctx?.get?.('tools')
    } catch {
      return undefined
    }
  })()
  if (!tools || typeof tools.register !== 'function') {
    ctx.logger?.warn?.(`[${PLUGIN_NAME}] 没有 tools 服务，memory_wiki 未注册`)
    return
  }
  resolveDefineTool()
    .then((defineTool) => {
      const spec = {
        name: 'memory_wiki',
        description:
          '读「记忆地图」的某个主题页（比 memory_search 更适合看全景：一个主题的要点、结论、相关主题链接）。' +
          '不填 topic 就列出所有主题。当你需要系统了解某个项目/环境/规则的整体情况时用它。',
        parameters: {
          topic: { type: 'string', description: '主题名（注入里的 WIKI 段列出的那些）；不填 = 列出所有主题' },
        },
        async execute(args) {
          const topic = String(args?.topic || '').trim()
          if (!topic) {
            const topics = listWikiTopics(cfg.memoryDir)
            return {
              ok: true,
              topics,
              note: topics.length ? '用 memory_wiki(topic) 取某个主题的整页' : '还没有主题页 —— 让做梦整理跑一轮会生成',
            }
          }
          const page = readWikiPage(cfg.memoryDir, topic)
          if (!page) {
            const topics = listWikiTopics(cfg.memoryDir)
            return { ok: false, error: `没有「${topic}」这个主题`, topics }
          }
          return { ok: true, topic, content: page }
        },
      }
      try {
        tools.register(defineTool(spec))
        ctx.logger?.info?.(`[${PLUGIN_NAME}] memory_wiki 已注册`)
      } catch (e) {
        ctx.logger?.warn?.(`[${PLUGIN_NAME}] memory_wiki 注册失败：${e.message}`)
      }
    })
    .catch((e) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] memory_wiki 初始化失败：${e.message}`))
}

// ─────────────────────────────────────────────────────────────────────
// 写入：memory_remember —— 让模型主动记（等价 Hermes 的 memory 工具）
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// 表征层（wiki）—— 2026-11-14 加，对齐 Anthropic 文章里「dreaming 构建表征」
//
// 文章的核心发现：光有搜索不够，光有 wiki 也不够；
//   纯搜索 53% → 搜索 + wiki 61%，还省下每题约 2 万 token。
// wiki 的作用是给记忆画地图：按主题聚合、互相链接，模型顺着链接走比盲搜快。
//
// 我们的落地方式（有意区别于文章）：
//   - wiki **绝不进注入区**（文章明确警告顶层必须小，注入的错笔记会污染每个会话）；
//   - wiki 存在 <memoryDir>/wiki/ 下，一个主题一个 .md，由做梦整理时维护；
//   - 注入区只带一份极小的**索引**（§WIKI 段落，默认 ≤600 字符），
//     告诉模型「有哪些主题、想细看就 memory_wiki('主题')」；
//   - memory_search 命中时也顺手提示相关 wiki 主题，等于链接。
// ─────────────────────────────────────────────────────────────────────

const WIKI_DIR = 'wiki'
const WIKI_INDEX_FILE = 'WIKI-INDEX.md'

function wikiDirOf(dir) {
  return path.join(dir, WIKI_DIR)
}

/** 读某个 wiki 主题页；没有返回 null。 */
function readWikiPage(dir, topic) {
  try {
    const safe = String(topic || '').replace(/[\\/:*?"<>|]/g, '').trim()
    if (!safe) return null
    const p = path.join(wikiDirOf(dir), `${safe}.md`)
    if (!existsSync(p)) return null
    return readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/** 列出全部 wiki 主题（文件名去扩展名）。 */
function listWikiTopics(dir) {
  try {
    const d = wikiDirOf(dir)
    if (!existsSync(d)) return []
    return readdirSync(d)
      .filter((f) => f.endsWith('.md') && f !== WIKI_INDEX_FILE)
      .map((f) => f.replace(/\.md$/, ''))
      .sort()
  } catch {
    return []
  }
}

/**
 * 写一个 wiki 主题页（做梦用）。
 * 内容自带最小纪律：首行是主题一句话说明，之后是「要点」和「相关」链接。
 */
function writeWikiPage(dir, topic, body) {
  try {
    const safe = String(topic || '').replace(/[\\/:*?"<>|]/g, '').trim()
    if (!safe) return { ok: false, error: '主题为空' }
    const d = wikiDirOf(dir)
    mkdirSync(d, { recursive: true })
    const p = path.join(d, `${safe}.md`)
    const text = String(body || '').trim()
    if (!text) return { ok: false, error: '内容为空' }
    writeFileSync(p, text.endsWith('\n') ? text : text + '\n', 'utf-8')
    return { ok: true, topic: safe, chars: text.length }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 细节下沉（2026-11-14 加）—— 对齐 Anthropic 文章「把细节挪到下层、只留链接」。
 *
 * 文章原话：注入的错笔记会污染每个会话、指令越长模型越不照做，
 * 「所以记忆层级的顶层必须保持相对小，做梦在这里的工作很大一部分就是**保持它小**
 * ——把一些细节移到层级下方，只留下链接」。
 *
 * 我们之前的做法是「预算满了就顶掉最差的条目」= 直接丢。现在改成：
 *   先把要腾出来的条目**挪进一个归档 wiki 页**，挪成功才从记忆里移除，
 *   并留下一个链接条目（`详见 wiki: 归档`）。这样预算腾出来了，内容也没丢。
 */
const ARCHIVE_TOPIC = '归档'

/** 把一个条目追加进归档 wiki 页（幂等：同一条不会写两遍）。 */
function sinkEntryToWiki(dir, text) {
  try {
    const d = wikiDirOf(dir)
    mkdirSync(d, { recursive: true })
    const p = path.join(d, `${ARCHIVE_TOPIC}.md`)
    const line = `- ${String(text).trim()}`
    let body = existsSync(p) ? readFileSync(p, 'utf-8') : ''
    if (!body) {
      body = '# 归档\n从常驻记忆下沉下来的细节（预算紧张时挪到这里，内容不丢）。\n\n'
    }
    if (body.includes(line)) return { ok: true, dup: true }
    if (!body.endsWith('\n')) body += '\n'
    body += line + '\n'
    writeFileSync(p, body, 'utf-8')
    return { ok: true, dup: false }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 从归档页里取回某条（用于恢复）。 */
function liftEntryFromWiki(dir, text) {
  try {
    const p = path.join(wikiDirOf(dir), `${ARCHIVE_TOPIC}.md`)
    if (!existsSync(p)) return false
    const body = readFileSync(p, 'utf-8')
    const line = `- ${String(text).trim()}`
    if (!body.includes(line)) return false
    const next = body
      .split(/\r?\n/)
      .filter((l) => l.trim() !== line.trim())
      .join('\n')
    writeFileSync(p, next, 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 归档页里现在有多少条（面板显示用）。 */
function archiveCount(dir) {
  try {
    const p = path.join(wikiDirOf(dir), `${ARCHIVE_TOPIC}.md`)
    if (!existsSync(p)) return 0
    return readFileSync(p, 'utf-8').split(/\r?\n/).filter((l) => /^-\s+\S/.test(l)).length
  } catch {
    return 0
  }
}

/**
 * 组装注入用的 wiki 索引（小）。
 * 文章的做法是加载 MEMORY.md 前 200 行当索引；我们生成一份更短的目录：
 * 主题名 + 一句话摘要，超预算就截断。
 */
function buildWikiIndexBlock(cfg, budget = 600) {
  const topics = listWikiTopics(cfg.memoryDir)
  if (!topics.length) return ''
  const lines = []
  let used = 0
  for (const t of topics) {
    const page = readWikiPage(cfg.memoryDir, t) || ''
    // 取第一行非空文本当摘要
    const first = page.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
    const summary = first.replace(/^#+\s*/, '').slice(0, 48)
    const line = summary ? `- ${t}：${summary}` : `- ${t}`
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  return (
    '## WIKI（记忆地图：想细看某个主题就用 memory_wiki 取整页）\n' +
    lines.join('\n')
  )
}

/** 从查询里找相关的 wiki 主题（主题名出现在查询里，或两者有共同双字组）。 */
function relatedWikiTopics(dir, query, limit = 3) {
  const topics = listWikiTopics(dir)
  if (!topics.length) return []
  const q = normForCompare(query)
  if (!q) return []
  const scored = []
  for (const t of topics) {
    const nt = normForCompare(t)
    if (!nt) continue
    let score = 0
    if (q.includes(nt)) score = 1
    else if (nt.includes(q)) score = 0.9
    else score = similarityOf(query, t)
    // 主题页正文也有帮助
    if (score < 0.3) {
      const page = normForCompare(readWikiPage(dir, t) || '')
      if (page.includes(q)) score = 0.5
    }
    if (score >= 0.3) scored.push({ topic: t, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

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

/**
 * 统一写入口；工具和自动回填共用，保证预算口径一致。
 *
 * 2026-10-28 加两道闸（`guard` 默认开）：
 *   ① add 之前先比墓碑：这条被删过（换说法也算）就不写回来；
 *   ② add 之前先比现有条目：≥75% 相似就跳过，别把同一件事写两遍。
 * 真要我行我素地写（人当场点名要加），传 `force: true` 越过这两道闸。
 * 另外每次写成功都会把「被删掉的条目」记进墓碑 —— 面板删、工具删都算。
 */
function writeMemory(
  cfg,
  { target, action, content, oldText, newText, operations, entries, force } = {},
) {
  const file = TARGET_FILE[target] || 'MEMORY.md'
  const opts = { maxChars: maxCharsOf(cfg, file) }
  const dir = cfg.memoryDir
  const before = readStore(dir, file).entries

  if (action === 'add') {
    if (!content) return { ok: false, error: 'add 需要 content' }
    const item = String(content).trim()
    // 🔴 草稿拦截（2026-11-14 加）：提炼模型会把「思考过程」当事实写进来，例如
    // 「用户问X？这可能反映偏好…不要输出 USER」「This is stable preference?」
    // 实测 USER.md 里 8 条有 5 条是这种草稿，把记忆挤满了。这里直接拒。
    if (!force && looksLikeDraft(item)) {
      _probe(`守卫拦下草稿：${item.slice(0, 60)}`)
      return {
        ok: false,
        file,
        error: '这条像提炼时的思考草稿（含自问自答/不确定表述），不是结论，不写入',
        rejected: true,
      }
    }
    if (before.includes(item)) {
      return { ok: true, file, applied: { added: 0 }, note: '这条一模一样已经在里面了，跳过' }
    }
    if (!force) {
      const tomb = hitRejected(dir, item)
      if (tomb) {
        _probe(`守卫拦下：墓碑命中 ${Math.round(tomb.ratio * 100)}%｜${tomb.text.slice(0, 60)}`)
        return {
          ok: false,
          file,
          error: `这条被删过（相似 ${Math.round(tomb.ratio * 100)}%：${tomb.text.slice(0, 40)}），不再写回来`,
          rejected: true,
        }
      }
      // 相似度门槛 60%（2026-11-14 从 75% 下调）：
      // 那两条「插件运行无感」和「插件交互无感」实测相似度正好 70%，
      // 卡在 75% 门槛下被放过去，于是同一件事记了两遍。
      // 中文双字组对同义改写本来就不够敏感，60% 更贴合「讲的是同一件事」。
      const near = findSimilar(dir, file, item).find((s) => s.ratio >= 60)
      if (near) {
        _probe(`守卫拦下：跟现有条目 ${near.ratio}% 相似｜${near.entry.slice(0, 60)}`)
        return {
          ok: true,
          file,
          applied: { added: 0 },
          note: `跟已有条目 ${near.ratio}% 相似，跳过：${near.entry.slice(0, 40)}`,
          duplicate: true,
        }
      }
    }
    const first = { ...batchStore(dir, file, { add: [item] }, opts), file }
    if (first.ok) return withRejectCapture(cfg, file, before, first)
    // 预算顶到天花板：先**下沉**（挪进归档 wiki），沉不下去才顶掉。
    // 这是文章说的「把细节移到层级下方、只留链接」，而不是直接丢内容。
    if (/超预算/.test(first.error || '')) {
      const over = Math.max(0, (first.chars || 0) - (first.maxChars || opts.maxChars))
      const plan = planEviction(before, over + 40, { dir, file, protectText: item })
      if (plan.evicted.length) {
        // 先尝试把每一条挪进归档页；成功才从记忆里移除
        const sunk = []
        const justDropped = []
        for (const e of plan.evicted) {
          const r = sinkEntryToWiki(dir, e.text)
          if (r.ok) sunk.push(e)
          else justDropped.push(e)
        }
        const removeTexts = new Set(sunk.map((e) => e.text))
        const keepList = plan.keep.filter((t) => !removeTexts.has(t))
        const res = writeStore(dir, file, [...keepList, item], opts)
        if (res.ok) {
          recordEvicted(dir, file, plan.evicted)
          _probe(
            `腾位：下沉 ${sunk.length} 条到 wiki「${ARCHIVE_TOPIC}」` +
              (justDropped.length ? `、顶掉 ${justDropped.length} 条` : '') +
              `（腾出约 ${plan.saved} 字符）｜` +
              plan.evicted.map((e) => `${e.text.slice(0, 24)}（${e.reason}）`).join(' / '),
          )
          // 注意：这里**不**走 withRejectCapture —— 被下沉的是插件自己挪走的，
          // 不是主人删的，记进墓碑会让这些内容以后永远写不回来。
          return {
            ...res,
            file,
            evicted: plan.evicted,
            sunk: sunk.map((e) => e.text),
            note:
              `预算满了，把 ${sunk.length} 条细节下沉到「记忆地图」的「${ARCHIVE_TOPIC}」页` +
              (justDropped.length ? `（另顶掉 ${justDropped.length} 条）` : '') +
              `：${sunk.map((e) => e.text.slice(0, 16)).join('、') || '—'}`,
          }
        }
        return {
          ok: false,
          file,
          error: `${first.error}；已尝试顶掉 ${plan.evicted.length} 条，仍放不下`,
          evictedTried: plan.evicted,
        }
      }
      return {
        ok: false,
        file,
        error: `${first.error}（没有可顶掉的：其余条目都锁着或太新）`,
      }
    }
    return first
  }
  if (action === 'remove') {
    if (!oldText) return { ok: false, error: 'remove 需要 oldText' }
    return withRejectCapture(cfg, file, before, { ...batchStore(dir, file, { remove: [oldText] }, opts), file })
  }
  if (action === 'replace') {
    if (!oldText || newText === undefined) {
      return { ok: false, error: 'replace 需要 oldText + newText' }
    }
    return withRejectCapture(cfg, file, before, { ...patchStore(dir, file, { oldText, newText }, opts), file })
  }
  if (action === 'batch') {
    const ops = { ...(operations || {}) }
    // batch 里的 add 也过一遍墓碑（manual 场景同样不该偷偷长回来）
    if (Array.isArray(ops.add) && ops.add.length) {
      ops.add = ops.add.filter((t) => {
        if (force) return true
        const tomb = hitRejected(dir, t)
        if (tomb) {
          _probe(`守卫拦下(batch)：墓碑命中 ${Math.round(tomb.ratio * 100)}%｜${String(t).slice(0, 60)}`)
          return false
        }
        return true
      })
    }
    return withRejectCapture(cfg, file, before, { ...batchStore(dir, file, ops, opts), file })
  }
  if (action === 'set') {
    // 整份覆盖：给面板用（人看得见整张清单，改完一次提交）
    return withRejectCapture(cfg, file, before, {
      ...writeStore(dir, file, Array.isArray(entries) ? entries : [], opts),
      file,
    })
  }
  return { ok: false, error: `未知 action：${action}（add｜remove｜replace｜batch）` }
}

/** 写成功后对比前后条目，把「消失的」记进墓碑（这就是「我删过的别再回来」的那份账）。 */
function withRejectCapture(cfg, file, before, result) {
  try {
    if (result?.ok && Array.isArray(result.entries)) {
      const gone = before.filter((e) => !result.entries.includes(e))
      if (gone.length) {
        const n = rememberRejected(cfg.memoryDir, gone)
        if (n) _probe(`墓碑记下 ${n} 条被删条目（${file}）`)
      }
    }
  } catch {
    /* 记墓碑失败不影响写盘 */
  }
  return result
}

function registerWriteTool(ctx, cfg) {
  // 同 registerSearchTool：一律走 ctx.get()，别读 ctx.tools。
  const tools = (() => {
    try {
      return ctx?.get?.('tools')
    } catch {
      return undefined
    }
  })()
  if (!tools || typeof tools.register !== 'function') return
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
          force: {
            type: 'boolean',
            description:
              '默认不加。守卫会拦下「跟你删过的条目太像」和「跟现有条目 ≥75% 相似」的写入；' +
              '只有人当场明确要求写回时才传 true。',
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
        tools.register(defineTool(spec))
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

const EXTRACT_PROMPT = (body, known = '') => `你在给一个长期记忆系统做提炼。下面是刚结束的一轮对话，请挑出「值得长期记住」的事实。

按行输出，每行必须以 USER: 或 ENV: 开头：
- USER: 关于用户本人的稳定事实（称呼、偏好、反感、说话方式、长期在做的事）。一次性的请求不算。
- ENV: 环境事实（路径、端口、配置规律、踩过的坑与解法、反复用到的命令）。一次性的操作过程不算。
${known ? `\n${known}\n` : ''}
规矩：
1. 一条只讲一件事，一句话讲完；不要编号、不要客套、不要解释。
2. 必须能从对话里直接看出，不许推测。
3. 没有值得记的就只输出一行：NONE
4. 别抄原文长句，压成结论。
5. 上面清单里已经有的、或者只是换个说法讲同一件事的，一律不要输出；被标成「删掉过」的，一个字都不要再写回来。
6. 🔴 只写**结论**，绝不写你的思考过程：不许出现「这可能反映」「是不是」「要不要输出」「值得记吗」「可能重复」这类自问自答、试探、权衡的句子。写进来的是给人看的结论，不是你的分析笔记。
7. 一条只讲一件事，写得像给人看的事实陈述（例：「主人要求插件交互无感，不要弹确认」），不要写成「用户说…这可能…」这种半成品。
8. 🔴 不要记「我们刚写的代码是怎么实现的」：函数名、字段名、配置项、公式、架构分层设计、模块怎么串，这些统统不记。理由：细节记不住也没用，真要翻细节直接看历史记录。这一层只留两类——**主人的稳定偏好**，和**下次还用得上的环境事实**（路径、端口、命令、踩过的坑与解法）。
   反例（都别记）：「记忆系统 USER 段上限 1375」「wiki 表征层正文存 memoryDir/wiki 下」「排序公式 log2(1+n)×2」「排序改变编号对应关系，cur 要同序重建」。
9. 🔴 不记任务进展和过程：不要写「已完成」「下一步做 X」「规划了三项」「前两项搞定了」。只记**当下仍然成立的事实**，不记「我们干到哪一步了」。

对话：
---
${body}
---

输出：`

/**
 * 做梦 prompt（2026-11-14 改：从「整份重写」改成「只报操作」）。
 *
 * 🔴 为什么改（两次血的教训）：原来要求模型「输出整理后的两份完整清单」，
 * 代码拿它整份覆盖文件。结果是——模型不可能逐字复述几十条原文，
 * 只要它漏抄一条、压缩一条、把几条并成一条，主人的记忆就被抹掉了。
 * 2026-11-14 实际发生两次：7 条 USER 被压成 386 字符，9 条 MEMORY 被砍成 5 条。
 *
 * 现在只让模型报**具体操作**（改哪条 / 删哪条 / 加什么），代码拿原文逐条执行：
 * 没被点名的条目一律原封不动 —— 从根上不可能丢记忆。而且无感，不用主人确认。
 *
 * 与 EXTRACT_PROMPT 的分工：
 *   - EXTRACT_PROMPT：从「刚结束的一轮对话」里采集新事实（USER:/ENV: 行）
 *   - DREAM_PROMPT：拿历史转录当依据，报出对已有条目的修正/合并/删除操作
 */
const DREAM_PROMPT = (known, snippets, wikiList = '') => `你在给一个长期记忆系统做「做梦」核对。下面是现有记忆条目，以及从历史会话转录里捞出来的相关片段。

【现有条目】（每条前面是它的编号）
${known}
${snippets ? `\n【相关转录片段（核对依据）】\n${snippets}\n` : ''}
【怎么判】
- 只依据上面的转录片段判断，不许推测、不许自己编新事实。
- 没把握的条目一律别动 —— 保持原样是默认动作。

【🔴 以「最终结论」为准，不许信会话中间的错结论】
一段长会话里，前面的判断经常是**错的、后来被推翻的**：
先以为 A，试了半天发现是 B，最后定成 C。这种情况下真正成立的是 **C**。
- 拿不准某条转录代表最终结论时，往下看后续片段里有没有「其实」「不对」「改成」「最终」「试通了」这类转折；
- 如果转录里只有中间过程、没有最终定论，就**别动这条记忆**（宁可不动，也不要拿半路结论去改）；
- 已知某条记忆被会话中的错误结论写歪了，且转录能证明最终结果是什么，就用 FIX 改成最终结论。

【只报操作，不要复述全文】
每行一条操作，格式任选其一（编号必须来自上面现有条目）：
- FIX 编号 => 改写后的完整条目内容
- DROP 编号
- ADD USER: 新条目内容
- ADD ENV: 新条目内容

⚠️ 编号是**两份清单连起来连续编的**（USER 在前、MEMORY 接着往下，条目前面的 [U]/[E] 标明归属）。
不要自己给 MEMORY 从 1 重新编号 —— 直接抄上面条目前的那个数字。

【还可以建「wiki 主题页」（可选）】
现有主题：
${wikiList || '（还没有主题页）'}
如果上面某些条目其实属于同一个大主题（比如「PS5 开发」「记忆插件」），可以写一个主题页把要点归拢起来：
WIKI 主题名
第一行写这个主题一句话说明
之后按需要写要点、结论、踩过的坑，以及「相关：另一个主题名」这样的链接

⚠️ 主题页要**提炼**，不要抄全文、不要把条目原样堆进去。
文章里的教训：wiki 做得太细会「比原文还大」，那等于什么都没抽象 —— 一个主题控制在 15 行内。

规矩：
1. 只对「转录里有明确依据」的条目动手；其余一律不写（不写 = 保持原样）。
2. FIX 只在原文确实错/过时时用，并且要把原文信息完整保留，只改错的那部分；不要借机把长条目压成短句。
3. DROP 只用于「被转录证明是错的」或「已经过时失效」的条目，不要因为觉得啰嗦就删。
4. 合并两条同义条目：用 FIX 改好保留的那条，再 DROP 另一条。
5. ADD 只在转录里出现了确实重要、且现有条目没覆盖的事实时才用。
   禁止 ADD 这类内容：代码实现细节（函数名/字段名/公式/架构分层）、任务进展（「已完成」「下一步」）。
   这一层只留主人的稳定偏好和下次还用得上的环境事实。
6. 被标记为「删掉过」的内容，一个字都不要再加回来。
7. 没有任何要改的就只输出：NONE

【输出】`

/**
 * 解析做梦的 wiki 操作（2026-11-14 加）。
 *
 * 格式（一次做梦里可以有多条，每条一块）：
 *   WIKI 主题名
 *   <主题页正文，可以多行，直到下一个 WIKI / 下一个操作 / 结尾>
 *
 * 为什么单独解析：wiki 是「表征层」，跟 USER/MEMORY 的条目操作不是一回事，
 * 混在一个解析器里会把多行正文切碎。
 */
export function parseWikiOps(text) {
  const lines = String(text || '').split(/\r?\n/)
  const ops = []
  let cur = null
  const flush = () => {
    if (!cur) return
    const body = cur.body.join('\n').trim()
    if (cur.topic && body.length >= 10) ops.push({ topic: cur.topic, body })
    cur = null
  }
  for (const raw of lines) {
    const line = raw.replace(/\*\*/g, '').trim()
    const m = /^WIKI\s+(.+)$/i.exec(line)
    if (m) {
      flush()
      const topic = m[1].trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 40)
      cur = { topic, body: [] }
      continue
    }
    // 别的操作类型出现时，结束当前 wiki 块
    if (/^(FIX|DROP|ADD)\b/i.test(line) || /^NONE$/i.test(line)) {
      flush()
      continue
    }
    if (cur) cur.body.push(raw)
  }
  flush()
  return ops
}

/**
 * 解析做梦的「操作指令」。
 * 认 FIX / DROP / ADD 三种；认不出来或编号越界的一律丢弃（宁可不改）。
 * @param counts { user: 条数, env: 条数 } —— 编号是各文件内部从 1 开始
 * FIX/DROP 的编号对应哪份文件？prompt 里两份清单分开编号，所以按「编号落在哪份的范围」判定：
 * 先 USER 后 MEMORY，编号连续。这里用 counts 还原归属。
 * 返回 [{ op:'fix', target, idx, text } | { op:'drop', target, idx } | { op:'add', target, text }]
 */
export function parseDreamOps(text, counts) {
  const uCount = Number(counts?.user) || 0
  const ops = []
  const resolve = (n) => {
    const zero = n - 1
    if (zero >= 0 && zero < uCount) return { target: 'user', idx: zero }
    const idx = zero - uCount
    if (idx >= 0 && idx < (Number(counts?.env) || 0)) return { target: 'env', idx }
    return null
  }
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^[>*•‣·\-–—]+\s*/, '')
      .replace(/^\d+[.、)]\s*/, '')
      .replace(/\*\*/g, '')
      .trim()
    if (!line || /^NONE\b/i.test(line)) continue
    let m = /^FIX\s*#?(\d+)\s*(?:=>|→|:)\s*(.+)$/i.exec(line)
    if (m) {
      const hit = resolve(Number(m[1]))
      const body = m[2].trim()
      if (hit && body.length >= 4) ops.push({ op: 'fix', target: hit.target, idx: hit.idx, text: body })
      continue
    }
    m = /^DROP\s*#?(\d+)\s*$/i.exec(line)
    if (m) {
      const hit = resolve(Number(m[1]))
      if (hit) ops.push({ op: 'drop', target: hit.target, idx: hit.idx })
      continue
    }
    m = /^ADD\s*(USER|ENV)\s*[:：]\s*(.+)$/i.exec(line)
    if (m) {
      const body = m[2].trim()
      if (body.length >= 4) {
        ops.push({ op: 'add', target: m[1].toUpperCase() === 'USER' ? 'user' : 'env', text: body })
      }
      continue
    }
  }
  return ops
}

/**
 * 做梦通道的模型选择（照刷B站插件的 provider + model 双字段）。
 *
 * 返回一份覆盖后的 cfg：provider 决定走哪条通道，model 覆盖模型名。
 * 留空 = 跟提炼通道（extractModel）同一个模型。
 */
function dreamModelCfg(cfg) {
  const provider = String(cfg.dreamModelProvider || '').trim()
  const model = String(cfg.dreamModelName || '').trim()
  const out = { ...cfg }
  if (provider === 'headless') {
    // 显式要求走 headless：清掉 provider/model，HTTP 和 llm 都拿不到 → 自然回退 headless
    out.extractProvider = ''
    out.extractModel = ''
    return out
  }
  if (provider) {
    // 真正指定了宿主 provider：走 llm 服务（能选任意可用模型，不再绑死 opencode-go）
    out.extractProvider = provider
    if (model) out.extractModel = model
    return out
  }
  if (model) out.extractModel = model
  return out
}

/** 从一条记忆条目里抽检索关键词（去停用词，取前几个词）。 */
function keywordsOf(entry) {
  const stop = new Set([
    '的', '了', '是', '在', '和', '与', '或', '不', '要', '用', '时', '可', '以',
    '为', '有', '对', '上', '下', '中', '里', '及', '并', '后', '前', '个', '条',
    '我们', '你们', '一个', '这个', '那个', '以及', '并且', '然后', '如果', '因为',
    '所以', '但是', '需要', '进行', '通过', '可以', '就是', '不是', '没有',
  ])
  const parts = String(entry)
    .trim()
    .split(/[^0-9A-Za-z一-鿿]+/)
    .filter(Boolean)
  return parts.filter((p) => p.length >= 2 && !stop.has(p)).slice(0, 3)
}

/**
 * 组装做梦的输入：现有两份清单（**带编号**，供模型指名操作）+ 相关转录片段。
 * 每个文件最多取前 40 条、每条抽 3 个词、总片段预算由 cfg.dreamSnippetChars 控制。
 * 返回的 items 里带每条自己的编号，供 parseDreamOps 的 idx 对应。
 */
function buildDreamContext(cfg) {
  const files = [
    { file: 'USER.md', label: 'USER 层（关于主人的稳定事实）', target: 'user' },
    { file: 'MEMORY.md', label: 'MEMORY 层（环境事实、规则、坑）', target: 'env' },
  ]
  const knownLines = []
  const queries = []
  const numbered = { user: [], env: [] }
  // 编号连续编号（USER 接着 MEMORY），并且每条都带归属前缀，
  // 避免模型误以为 MEMORY 是独立从 1 开始 —— 实测它会这么以为，然后改错位置。
  let serial = 0
  for (const f of files) {
    const { entries } = readStore(cfg.memoryDir, f.file)
    if (!entries.length) continue
    const tag = f.target === 'user' ? 'U' : 'E'
    // 🔴 按访问频率排序（2026-11-14 加，对齐文章「按访问频率调做梦节奏」）：
    // 高频 + 久未核对的条目排在前面，让有限的算力先花在真在用的记忆上。
    // ⚠️ 必须保存这套顺序，后面执行 FIX/DROP 时按同一套索引走，否则会改错条目。
    const ordered = sortByUsagePriority(cfg.memoryDir, entries).map((x) => x.e)
    knownLines.push(`## ${f.label}（${f.file}）`)
    ordered.slice(0, 40).forEach((e) => {
      serial += 1
      knownLines.push(`${serial}. [${tag}] ${e}`)
      numbered[f.target].push(e)
      for (const kw of keywordsOf(e)) {
        if (!queries.includes(kw)) queries.push(kw)
      }
    })
  }
  if (!knownLines.length) return { known: '', snippets: '', numbered }

  const known = knownLines.join('\n')
  let snippets = ''
  const budget = Number(cfg.dreamSnippetChars) || 6000
  // 🔴 以最终结论为准（2026-11-14）：同一个会话里，越靠后的内容越接近最终结论
  // （前面可能是「先以为 A」，后面才「其实不对，是 B」）。所以按会话把命中排序，
  // 每个会话优先给**最后**的片段，而不是最早的那条。
  const bySession = new Map() // session -> [{ at, line }]
  for (const kw of queries.slice(0, 8)) {
    if (snippets.length >= budget) break
    const r = searchMemory(cfg.memoryDir, { query: kw, limit: 5 })
    if (!r.ok || !r.hits?.length) continue
    for (const hit of r.hits) {
      const key = hit.session || hit.title || '?'
      if (!bySession.has(key)) bySession.set(key, [])
      const list = bySession.get(key)
      const line = `[${hit.title}｜${hit.matched_at || '?'}] ${hit.snippet}`
      if (list.some((x) => x.line === line)) continue
      list.push({ at: hit.matched_at || '', line })
    }
  }
  // 每个会话内部按时间排序，取靠后的（接近最终结论）
  for (const list of bySession.values()) {
    list.sort((a, b) => String(a.at).localeCompare(String(b.at)))
    for (const item of list.slice(-3)) {
      if (snippets.length + item.line.length > budget) break
      snippets += `\n- ${item.line}`
    }
    if (snippets.length >= budget) break
  }
  return { known, snippets: snippets.trim(), numbered }
}

/**
 * 解析做梦输出：两个区块 [USER] / [ENV]，区块内按 § 或空行分隔条目。
 * 解析不出来返回 null（不写回）。
 */
export function parseDream(text) {
  const raw = String(text || '')
  const user = []
  const env = []
  // 先按区块标记切块：[前导, 'USER', 内容, 'ENV', 内容, ...]
  const blocks = raw.split(/\[(USER|ENV)\]/i)
  for (let i = 1; i + 1 < blocks.length; i += 2) {
    const which = blocks[i].trim().toUpperCase()
    const body = blocks[i + 1] || ''
    const target = which === 'USER' ? user : env
    // 一行一条：每行剥掉装饰符；§ 分隔行本身跳过（它是条目之间的分隔，不是内容）
    for (const line of body.split(/\r?\n/)) {
      const s = line
        .trim()
        .replace(/^[>*•‣·\-–—]+\s*/, '') // 列表符 / 引用符
        .replace(/^\d+[.、)]\s*/, '') // 编号
        .replace(/\*\*/g, '') // 粗体
        .replace(/`/g, '') // 行内代码
        .replace(/^#+\s*/, '') // 标题井号
        .trim()
      if (!s || s === '§') continue
      target.push(s)
    }
  }
  if (!user.length && !env.length) return null
  return { user, env }
}

/**
 * 跑一次做梦：组装输入 → 选模型通道 → 解析操作 → 逐条执行（没点名的原样保留）。
 * 无感：不需要人工确认，因为它只做增量，不可能整份覆盖。
 * 返回 { ok, changed, applied, skipped, note?, raw? }
 */
export async function runDream(ctx, cfg) {
  const { known, snippets, numbered } = buildDreamContext(cfg)
  if (!known) return { ok: false, error: '现有记忆为空，没有可整理的内容' }
  // 现有 wiki 主题（让模型知道有哪些、可以更新或新建）
  const wikiTopics = listWikiTopics(cfg.memoryDir)
  const wikiList = wikiTopics.length ? wikiTopics.map((t) => `- ${t}`).join('\n') : ''

  const text = await runExtract(DREAM_PROMPT(known, snippets, wikiList), dreamModelCfg(cfg), ctx)
  if (!text) {
    return { ok: false, error: '做梦没返回 —— HTTP 和 headless 两条路都没回话' }
  }

  const limits = {}
  for (const f of cfg.files || []) limits[f.name] = f.maxChars || 4000

  // 🔴 cur 必须用**和 prompt 同一套顺序**（numbered），不能直接读原文件：
  // 提示词里的编号是按访问频率排过序的，读原文件会错位、改错条目。
  const cur = {
    user: [...numbered.user],
    env: [...numbered.env],
  }
  // 模型只看到前 40 条，编号也只能落在这个范围内
  const ops = parseDreamOps(text, { user: cur.user.length, env: cur.env.length })
  // wiki 操作单独解析（文章里 dreaming 的核心产出之一就是「重建表征」）
  const wikiOps = parseWikiOps(text)
  if (ops.length === 0 && wikiOps.length === 0) {
    // 即使结果是无变化，这些条目也是**真被核对过**了 —— 必须标上 checked，
    // 否则它们永远算「从未核对」，下次做梦还是排最前，白烧算力。
    try {
      recordChecked(cfg.memoryDir, [...cur.user, ...cur.env])
    } catch {
      /* 统计失败不影响主流程 */
    }
    _probe('做梦：没有需要改的（NONE 或没认出操作），已标记核对')
    return { ok: true, changed: 0, applied: [], note: '没有需要改的' }
  }
  // 先把 wiki 写掉（它不进注入区，失败也不影响记忆文件）
  const wikiWritten = []
  for (const w of wikiOps) {
    const r = writeWikiPage(cfg.memoryDir, w.topic, w.body)
    if (r.ok) {
      wikiWritten.push(`${w.topic}（${r.chars} 字符）`)
      _probe(`wiki 写回：${w.topic} ${r.chars} 字符`)
    } else {
      _probe(`wiki 写回失败：${w.topic} ${r.error}`)
    }
  }
  if (ops.length === 0) {
    return {
      ok: true,
      changed: wikiWritten.length,
      applied: wikiWritten.map((t) => `wiki: ${t}`),
      note: wikiWritten.length ? '' : '没有需要改的',
    }
  }

  // 逐条执行操作：**没被点名的条目原样保留**（这是不丢记忆的根本保证）
  // 🔴 写回必须用**完整原文件**，不能用 cur（它只有前 40 条）：
  // 直接拿 cur 写回会把第 41 条之后的内容全丢掉。
  // 做法：用编号找到「被点名的那条原文」，再到完整清单里定位它的真实下标。
  const full = {
    user: readStore(cfg.memoryDir, 'USER.md').entries,
    env: readStore(cfg.memoryDir, 'MEMORY.md').entries,
  }
  const next = { user: [...full.user], env: [...full.env] }
  const applied = []
  const byTarget = { user: [], env: [] }
  for (const o of ops) {
    if (o.target === 'user' || o.target === 'env') byTarget[o.target].push(o)
  }
  for (const target of ['user', 'env']) {
    const list = next[target]
    const fixes = byTarget[target].filter((o) => o.op === 'fix')
    const adds = byTarget[target].filter((o) => o.op === 'add')
    const dropTexts = []
    for (const o of fixes) {
      const orig = cur[target][o.idx]
      const real = orig === undefined ? -1 : list.indexOf(orig)
      if (real >= 0) list[real] = o.text
      else _probe(`做梦：FIX 找不到原文（${target}#${o.idx + 1}），跳过`)
    }
    for (const o of byTarget[target].filter((x) => x.op === 'drop')) {
      const orig = cur[target][o.idx]
      if (orig !== undefined) dropTexts.push(orig)
    }
    if (dropTexts.length) {
      next[target] = list.filter((e) => !dropTexts.includes(e))
    }
    for (const a of adds) {
      if (!next[target].includes(a.text)) next[target].push(a.text)
    }
  }

  const written = { user: 0, env: 0 }
  const skipped = []
  for (const [target, file] of [['user', 'USER.md'], ['env', 'MEMORY.md']]) {
    const before = full[target]
    const items = next[target]
    const beforeChars = before.reduce((n, s) => n + String(s).length, 0)
    const afterChars = items.reduce((n, s) => n + String(s).length, 0)
    if (beforeChars === afterChars && before.length === items.length) {
      continue
    }
    // 兜底：操作执行完仍不该大幅缩水（防模型给出大量 DROP）
    if (before.length >= 3 && items.length < Math.ceil(before.length * 0.6)) {
      skipped.push(`${file}: 要删掉 ${before.length - items.length} 条（剩 ${items.length}/${before.length}），太狠，这轮不写`)
      _probe(`做梦写回被拦：${file} ${before.length}→${items.length} 条，删除比例过高`)
      continue
    }
    const res = writeStore(cfg.memoryDir, file, items, { maxChars: limits[file] || 4000 })
    if (res.ok) {
      written[target] = res.entries.length
      applied.push(`${file}: ${before.length}→${res.entries.length} 条`)
      _probe(`做梦写回：${file} ${res.entries.length} 条 / ${res.chars} 字符（备份 ${res.backup}）`)
    } else {
      skipped.push(`${file}: ${String(res.error).slice(0, 80)}`)
      _probe(`做梦写回被拒：${file} ${res.error}`)
    }
  }

  if (applied.length || wikiWritten.length) {
    ctx.logger?.info?.(`[${PLUGIN_NAME}] 做梦整理：${applied.join('；')}${wikiWritten.length ? `；wiki ${wikiWritten.join('、')}` : ''}`)
  }
  // 标记这批条目已被核对过 —— 下次做梦它们会排到后面，
  // 让算力轮到久未核对的条目（对齐文章「按访问频率调做梦节奏」）。
  try {
    const checked = []
    for (const target of ['user', 'env']) {
      for (const o of byTarget[target]) {
        const orig = cur[target][o.idx]
        if (orig !== undefined) checked.push(orig)
      }
    }
    recordChecked(cfg.memoryDir, checked)
  } catch {
    /* 统计失败不影响主流程 */
  }
  return {
    ok: true,
    changed: applied.length,
    applied,
    skipped,
    opCount: ops.length,
    raw: String(text).slice(0, 1500),
  }
}

/**
 * 跑一次 headless agent 做提炼；失败一律返回 null，不抛。
 *
 * ⚠️ prompt **必须走 stdin，不能塞进 argv**（2026-10-21 实测踩到的坑）：
 *    Windows 上 dsh 是 .cmd 壳，spawn 它必须 `shell: true`，而 shell 走 cmd.exe ——
 *    **cmd.exe 把换行当成命令分隔符**。多行 prompt 塞进 argv 的结果是：
 *    只有第一行成了位置参数，格式要求和对话正文全部丢失。
 *
 *    现象：面板点「现在提炼」永远「USER 0 条 / ENV 0 条」，
 *    而模型回的是「这轮没有可提炼的内容」—— 它压根没收到对话。实测只传进去 42 个字符。
 *
 *    自己拼 exe + cli.js 绕开 shell 也试过：直接 spawn 那个 exe 完全没输出，
 *    不通。正解就是喂 stdin —— 内容不进命令行，换行怎么都安全。
 *    实测：多行 prompt 经 stdin 送达后，模型能准确答出「3 行；关键词是蓝色鲸鱼」。
 */
function runHeadlessExtract(prompt, cfg) {
  return new Promise((resolve) => {
    const cmd = process.env.DSH_CLI || 'dsh'
    let out = ''
    let child
    try {
      child = spawn(cmd, ['--profile', 'headless'], {
        cwd: cfg.memoryDir,
        env: { ...process.env, [AUTO_ENV]: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        // dsh 在 Windows 上是 .cmd 壳，不走 shell 起不来。
        // Node 24 会因此报一个 DEP0190 警告（"args 未转义"）——这里参数全是我们
        // 自己写死的字面量（'--profile' / 'headless'），没有外部输入，不构成注入风险，
        // 警告可以忽略。别为了消警告改成 shell:false，那会让 Windows 上直接起不来。
        shell: process.platform === 'win32',
        windowsHide: true,
      })
    } catch {
      return resolve(null)
    }
    // 写完立刻 end()，让 headless 知道输入结束
    try {
      child.stdin.end(prompt, 'utf8')
    } catch {
      /* 写不进去就等超时把它收掉 */
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

// ─────────────────────────────────────────────────────────────────────
// 提炼通道一：HTTP 直调（2026-10-28 加）
//
// 为什么不用再 spawn：`dsh --profile headless` 每跑一次就在 ~/.dsh/sessions 落一个
// 会话目录（实测 10-21 到 10-28 堆了 479 个，桌面端会话列表被刷成「未分组」一大坨），
// 还要冷启动几秒到二十秒、每轮白吃 8.6k 字符的 AGENTS.md 和 2.3k 的技能目录。
// 提炼只需要「提炼要求 + 这一轮正文」，直接在 opencode-go 上打一发就够了。
//
// 端点/模型/凭据都从配置或 ~/.dsh/.env 拿；拿不到就返回 null，由 runExtract 回退 headless。
// ─────────────────────────────────────────────────────────────────────

/** 读 ~/.dsh/.env 的键值（只解析，不污染 process.env）。 */
function readEnvFile() {
  const out = {}
  try {
    const p = path.join(os.homedir(), '.dsh', '.env')
    if (!existsSync(p)) return out
    for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!m) continue
      if (/^\s*#/.test(line)) continue
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    /* 读不到就当没有 */
  }
  return out
}

function extractHttpConfig(cfg) {
  const env = { ...readEnvFile(), ...process.env }
  const keyName = cfg.extractApiKeyEnv
  const apiKey = keyName ? env[keyName] || '' : ''
  return {
    baseURL: String(cfg.extractBaseURL || '').replace(/\/+$/, ''),
    model: String(cfg.extractModel || ''),
    apiKey,
  }
}

/** 打一发 /chat/completions；任何一步不对就返回 null（交给调用方回退）。 */
async function runHttpExtract(prompt, cfg) {
  const { baseURL, model, apiKey } = extractHttpConfig(cfg)
  if (!baseURL || !model || !apiKey) return null
  const doFetch = globalThis.fetch
  if (typeof doFetch !== 'function') return null
  const timeout = Number(cfg.extractHttpTimeoutMs) || 90000
  try {
    const res = await doFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // opencode-go 强制要这个头，缺了直接 400 MissingSessionID（2026-10-28 实测）
        'x-opencode-session': 'dsh-memory-extract',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) {
      _probe(`提炼 HTTP：状态 ${res.status}，回退 headless`)
      return null
    }
    const obj = await res.json()
    const msg = (obj?.choices || [])[0]?.message || {}
    let text = msg.content || ''
    // 有的模型把正文塞进 reasoning_content，正文为空时退回去（跟本地摘要脚本一致）
    if (!String(text).trim()) text = msg.reasoning_content || ''
    const out = String(text).trim()
    return out || null
  } catch (e) {
    _probe(`提炼 HTTP 失败：${e?.message || e}，回退 headless`)
    return null
  }
}

/**
 * 把 cwd 换成会话目录名（照抄 DSH 的 projectKey 规则）：
 * 分隔符（/ \ :）连成一串压成一个 `-`，安全字符原样，其它字符转 `~XXXX`，两端包 `--`。
 * 用于「回退 headless 后把新落的会话删掉」时定位目录。
 */
function projectKeyOf(cwd) {
  const s = String(cwd || '')
  if (!s) return null
  let readable = ''
  let sepRun = false
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sepRun) readable += '-'
      sepRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      sepRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      sepRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

function sessionRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/** 某个 cwd 下现有的会话目录名。 */
function listSessionDirs(cwd) {
  const key = projectKeyOf(cwd)
  if (!key) return []
  try {
    return readdirSync(path.join(sessionRoot(), key)).filter((n) => n.startsWith('session-'))
  } catch {
    return []
  }
}

/**
 * 走宿主自己的 llm 服务发一次请求（2026-11-14 加）。
 *
 * 为什么：HTTP 直调绑死 opencode-go（403 订阅无效就全挂），headless 又不能指定模型。
 * 宿主 llm 服务是现成的：主人选什么 provider/model，它就用什么，插件不用自己管 key。
 * 拿不到 llm 服务/构造失败就返回 null，由调用方回退。
 */
async function runViaLlmService(ctx, prompt, provider, model) {
  const llm = (() => {
    try {
      return ctx?.get?.('llm')
    } catch {
      return undefined
    }
  })()
  if (!llm || typeof llm.stream !== 'function') {
    _probe('llm 通道：拿不到宿主 llm 服务，跳过')
    return null
  }
  // 消息对象自己搓，不 import @deepseek-ai/dsh-llm：
  // 插件装在 profile 的 node_modules 里，不一定能解析到宿主内部包（实测 ERR_MODULE_NOT_FOUND）。
  // llm.stream 只要求 role/content/source 形状，够用。
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'recall' },
  }
  let out = ''
  try {
    const signal = AbortSignal.timeout(120000)
    for await (const chunk of llm.stream({
      provider,
      model,
      messages: [message],
      maxTokens: 800,
      temperature: 0.2,
      signal,
    })) {
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') out += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error') {
          _probe(`llm 通道：模型报错 ${chunk.reason.failure?.code || ''} ${String(chunk.reason.failure?.message || '').slice(0, 120)}`)
        }
        break
      }
    }
  } catch (e) {
    _probe(`llm 通道：抛错 ${String(e?.message || e).slice(0, 120)}`)
    return null
  }
  return out.trim() || null
}

/**
 * 统一提炼入口：优先宿主 llm 服务（选了 provider/model 时），
 * 再 HTTP，最后回退 headless；回退路径会把它新落的会话目录删掉。
 */
async function runExtract(prompt, cfg, ctx) {
  const provider = String(cfg.extractProvider || '').trim()
  const model = String(cfg.extractModel || '').trim()
  if (provider && model) {
    const viaLlm = await runViaLlmService(ctx, prompt, provider, model)
    if (viaLlm) {
      _probe(`提炼通道：宿主 llm 服务（${provider}/${model}）`)
      return viaLlm
    }
    _probe(`提炼通道：llm 服务没回话（${provider}/${model}），回退 HTTP/headless`)
  }
  const viaHttp = await runHttpExtract(prompt, cfg)
  if (viaHttp) {
    _probe('提炼通道：HTTP 直调（零会话）')
    return viaHttp
  }
  const before = new Set(listSessionDirs(cfg.memoryDir))
  _probe('提炼通道：回退 headless（跑完清理它落的会话）')
  const text = await runHeadlessExtract(prompt, cfg)
  const key = projectKeyOf(cfg.memoryDir)
  if (key) {
    for (const name of listSessionDirs(cfg.memoryDir)) {
      if (before.has(name)) continue
      const full = path.join(sessionRoot(), key, name)
      // Windows 上：shell:true 的 kill 只杀 cmd.exe，孙进程可能还活着占着目录，
      // 第一次 rmSync 常报 EPERM/EBUSY。重试两次就基本能收掉。
      let done = false
      for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
        try {
          rmSync(full, { recursive: true, force: true })
          _probe(`提炼会话已清理：${name}`)
          done = true
        } catch (e) {
          if (attempt === 2) _probe(`提炼会话清不掉（${e.code || e.message}）：${name}`)
          else await new Promise((r) => setTimeout(r, 200))
        }
      }
    }
  }
  return text
}

// ─────────────────────────────────────────────────────────────────────
// 墓碑 + 相似度守卫（2026-10-28 加）
//
// 主人的原话：「我自己删了错误的或者不想要的，提炼一轮还会加回来」。
// 原因有三层：① 提炼 prompt 不知道现有记忆里有什么；② 更不知道他删过什么；
// ③ 写入去重只认一字不差相同。这里把 ②③ 一起补上：
//   - 面板/工具每删掉一条，就把它的文本记进 .rejected.json（墓碑）
//   - 之后 add 之前先跟墓碑和现有条目比相似度（中文按双字组重合）
//   - 提炼 prompt 里带一份现有清单 + 删过清单，从源头少产废条目
// ─────────────────────────────────────────────────────────────────────

const REJECTED_FILE = '.rejected.json'
const REJECTED_MAX = 300

// ─────────────────────────────────────────────────────────────────────
// 使用统计（2026-11-14 加）—— 对齐 Anthropic 文章「按访问频率调做梦节奏」
//
// 文章原话：dreaming 需要算力，「持续核查全部记忆并不现实」，
// 建议「把做梦集中在容易变的信息上，或者按记忆被访问的频率来调做梦节奏」。
//
// 我们的落地：
//   - 注入时给每条记忆记「被注入过几次、最后一次是什么时候」；
//   - memory_search / memory_wiki 命中某条记忆或某个主题，也算一次访问
//     （那才是真正「被用到」的信号）；
//   - 做梦时按优先级排序：**高频 + 久未核对**的条目排前面，
//     让有限的算力先花在真在用的记忆上。
//   - 存 <memoryDir>/.usage.json，不进记忆正文、不占注入预算。
// ─────────────────────────────────────────────────────────────────────

const USAGE_FILE = '.usage.json'
const USAGE_MAX = 500

function normForCompare(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[，。、；：""''（）()《》【】!?！？,.;:]/g, '')
    .toLowerCase()
}

/** 读使用统计 → { [条目前缀hash]: { n, at, checked } } */
function readUsage(dir) {
  try {
    const p = path.join(dir, USAGE_FILE)
    if (!existsSync(p)) return {}
    const o = JSON.parse(readFileSync(p, 'utf-8'))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

function writeUsage(dir, map) {
  try {
    mkdirSync(dir, { recursive: true })
    // 只留用得最多/最近的若干条，防文件无限膨胀
    const keys = Object.keys(map)
    if (keys.length > USAGE_MAX) {
      const keep = keys
        .sort((a, b) => (map[b]?.at || 0) - (map[a]?.at || 0))
        .slice(0, USAGE_MAX)
      const next = {}
      for (const k of keep) next[k] = map[k]
      map = next
    }
    writeFileSync(path.join(dir, USAGE_FILE), JSON.stringify(map, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 条目的稳定键（用内容哈希前缀，条目改了就自然换键）。 */
function usageKey(text) {
  return hashText(text).slice(0, 12)
}

/** 记一次「这些条目被注入了」。 */
function recordInjected(dir, entries) {
  if (!Array.isArray(entries) || !entries.length) return
  const map = readUsage(dir)
  const now = Date.now()
  for (const e of entries) {
    const k = usageKey(e)
    const cur = map[k] || { n: 0, at: 0, checked: 0 }
    map[k] = { ...cur, n: cur.n + 1, at: now }
  }
  writeUsage(dir, map)
}

/** 记一次「这些条目被核对过」（做梦处理完就标）。 */
function recordChecked(dir, entries) {
  if (!Array.isArray(entries) || !entries.length) return
  const map = readUsage(dir)
  const now = Date.now()
  for (const e of entries) {
    const k = usageKey(e)
    const cur = map[k] || { n: 0, at: 0, checked: 0 }
    map[k] = { ...cur, checked: now }
  }
  writeUsage(dir, map)
}

/**
 * 给做梦的条目排序：高频 + 久未核对的排前面。
 * 分数 = 访问次数权重 + 距上次核对的天数权重；从未核对过的额外加权。
 */
function sortByUsagePriority(dir, entries) {
  const map = readUsage(dir)
  const now = Date.now()
  const DAY = 86400000
  return entries
    .map((e, i) => {
      const u = map[usageKey(e)] || { n: 0, at: 0, checked: 0 }
      const daysSinceCheck = u.checked ? (now - u.checked) / DAY : 30
      // 次数用 log 压一下，免得一条高频条目永远霸占队列
      const score = Math.log2(1 + u.n) * 2 + Math.min(daysSinceCheck, 60) / 10
      return { e, i, score, n: u.n }
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
}

/**
 * 这条像不像「提炼时的思考草稿」而不是结论（2026-11-14 加）。
 *
 * 为什么需要：提炼模型会把内心独白一起吐出来，实测 USER.md 8 条里 5 条是这种，
 * 例如「用户问X？这可能反映偏好…不要输出 USER」「This is stable preference?」。
 * 判据用「自问自答 + 元讨论」特征，宁可错杀几条也不让草稿占满记忆预算。
 */
export function looksLikeDraft(text) {
  const s = String(text || '')
  if (s.length < 4) return true
  if (/This is (stable|a )|possibly|not sure/i.test(s)) return true
  // 元讨论：在讨论「要不要记 / 算不算稳定 / 该写 USER 还是 ENV」
  if (/不要输出|该不该记|值不值得记|算不算|是技能|可能重复|是不是稳定/.test(s)) return true
  // 自问自答：句中带问号又在后面自己回答
  if (/[？?]/.test(s) && /(可能|大概|也许|应该是|但更像|不过|这是一次性)/.test(s)) return true
  // 明显的半成品尾巴
  if (/(值得 ENV\?|ENV\?|USER\?|是环境\/项目事实)/.test(s)) return true
  // 整句基本是英文（2026-11-14 加）：主人明确反感记忆里夹英文，
  // 实测「The memory exclusion rule is a stable configuration pattern...」就是这么混进来的。
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (s.match(/[A-Za-z]/g) || []).length
  if (cjk === 0 && latin > 20) return true
  // 中文里英文占大头（超过中文字数一半且拉丁字母够多）：不是正常的技术名词混排
  if (cjk > 0 && latin > 40 && latin > cjk * 0.8) return true
  // 光个头没内容（实测「出网配置」这种 4 个字的残句被写进来过）
  if (/^[\u4e00-\u9fff]{2,6}$/.test(s.trim())) return true
  // 🔴 代码实现说明（2026-11-14 加，主人点名要删的那类）
  // 提炼会把「我自己刚写的实现细节」当记忆存下来，例如
  // 「记忆系统 USER 段上限 1375…」「wiki 表征层设计——正文存 <memoryDir>/wiki/…」
  // 「做梦排序公式 log2(1+n)×2…」。这些是代码说明书，不是主人的环境事实，
  // 下次会话知道了也没用，纯占预算。判据看「函数名/常量名/公式」这类实现痕迹。
  if (/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\(\)|\b[A-Za-z_][A-Za-z0-9_]*\.(json|md|db)\b/.test(s) && /存|写|读|调用|参数|返回|公式|字段|配置项/.test(s)) {
    return true
  }
  if (/排序公式|log2\(|×2 \+|编号对应关系|同序重建|注入预算|字符索引|段上限/.test(s)) return true
  // 「我们家自己这套东西」的实现词：正文存哪、注入区放什么、字符数上限
  if (/表征层|注入区|memoryDir.*wiki|wiki.*memoryDir|<memoryDir>/.test(s)) return true
  // 任务进展而不是稳定事实：「已完成」「前两项」「规划了…三项」这类
  if (/(规划了|前两项|三项|已完成|待完成).*(层|调优|下沉|表征|频率)/.test(s)) return true
  if (/(表征层|访问频率|细节下沉).*(已完成|待做|规划)/.test(s)) return true
  return false
}

function bigramSet(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
  return set
}

/** 两个串的双字组重合度（0~1）；中文没空格，双字组够用且快。 */
function similarityOf(a, b) {
  const na = normForCompare(a)
  const nb = normForCompare(b)
  if (na.length < 2 || nb.length < 2) return 0
  const A = bigramSet(na)
  const B = bigramSet(nb)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter += 1
  return inter / Math.max(1, Math.min(A.size, B.size))
}

function readRejected(dir) {
  try {
    const p = path.join(dir, REJECTED_FILE)
    if (!existsSync(p)) return { items: [] }
    const obj = JSON.parse(readFileSync(p, 'utf-8'))
    const items = Array.isArray(obj?.items) ? obj.items.filter((x) => x && typeof x.text === 'string') : []
    return { items }
  } catch {
    return { items: [] }
  }
}

function writeRejected(dir, items) {
  try {
    mkdirSync(dir, { recursive: true })
    const keep = items.slice(-REJECTED_MAX)
    writeFileSync(path.join(dir, REJECTED_FILE), JSON.stringify({ items: keep }, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 记住「这些条目被删了」。完全重复的只留一条（刷新时间戳）。 */
function rememberRejected(dir, texts) {
  const add = (texts || []).map((t) => String(t || '').trim()).filter((t) => t.length >= 4)
  if (add.length === 0) return 0
  const { items } = readRejected(dir)
  const map = new Map(items.map((x) => [normForCompare(x.text), x]))
  const now = Date.now()
  for (const t of add) map.set(normForCompare(t), { text: t, at: now })
  writeRejected(dir, [...map.values()])
  return add.length
}

/** 和新条目最像的墓碑条目（超过阈值就算命中）。 */
function hitRejected(dir, text, threshold = 0.55) {
  const { items } = readRejected(dir)
  let best = null
  for (const it of items) {
    const ratio = similarityOf(text, it.text)
    if (ratio >= threshold && (!best || ratio > best.ratio)) best = { ...it, ratio }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────
// 锁定（.pinned.json）+ 预算腾位（2026-10-29 加）
//
// 主人原话：「这个逻辑优化一下 自动顶掉一些不重要的 重复的」+「再加个手动锁定功能」。
// 两件事其实是一套：预算顶到天花板时，插件自己挑最没价值的旧条目让位；
// 但人明确锁住的条目（.pinned.json）一条都不许动。
//
// 存文本而不是行内标记：记忆文件是纯文本、每行一条、直接注入上下文，
// 塞 @pin 之类的标记会污染注入内容，所以锁定状态单独一份 JSON。
// ─────────────────────────────────────────────────────────────────────

const PINNED_FILE = '.pinned.json'
const PINNED_MAX = 300
const EVICTED_FILE = '.evicted.json'
const EVICTED_MAX = 200
const MAX_EVICT_PER_WRITE = 6

function readPinned(dir) {
  try {
    const p = path.join(dir, PINNED_FILE)
    if (!existsSync(p)) return { items: [] }
    const obj = JSON.parse(readFileSync(p, 'utf-8'))
    return { items: Array.isArray(obj?.items) ? obj.items.filter((x) => x && typeof x.text === 'string') : [] }
  } catch {
    return { items: [] }
  }
}

function writePinned(dir, items) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, PINNED_FILE), JSON.stringify({ items: items.slice(-PINNED_MAX) }, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * 这条现在是不是锁着的。
 *
 * 只认「归一化后完全相同」：用相似度兜底会误伤 —— 实测两条只差「端口」两个字的
 * 近似条目会被判成同一条，于是连着两条一起被锁住，腾位时反而没得顶。
 * 代价：把条目手动改过字之后，锁定失效（面板会重新显示成未锁），这是可接受的。
 */
function isPinned(dir, text, file) {
  const { items } = readPinned(dir)
  const norm = normForCompare(text)
  for (const it of items) {
    if (file && it.file && it.file !== file) continue
    if (normForCompare(it.text) === norm) return true
  }
  return false
}

function setPinned(dir, { text, file, pinned }) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: '要锁哪一条？给 text' }
  const { items } = readPinned(dir)
  const norm = normForCompare(t)
  const kept = items.filter((it) => !(normForCompare(it.text) === norm && (!file || !it.file || it.file === file)))
  if (pinned !== false) kept.push({ text: t, file: file || '', at: Date.now() })
  const ok = writePinned(dir, kept)
  _probe(`锁定${pinned === false ? '取消' : ''}：${t.slice(0, 60)}${file ? `（${file}）` : ''}`)
  return { ok, text: t, file: file || '', pinned: pinned !== false, count: kept.length }
}

/** 把锁定清单按文件分组，给面板用。 */
function pinnedByFile(dir) {
  const out = {}
  for (const it of readPinned(dir).items) {
    const f = it.file || '*'
    ;(out[f] = out[f] || []).push(it.text)
  }
  return out
}

function readEvicted(dir) {
  try {
    const p = path.join(dir, EVICTED_FILE)
    if (!existsSync(p)) return { items: [] }
    const obj = JSON.parse(readFileSync(p, 'utf-8'))
    return { items: Array.isArray(obj?.items) ? obj.items : [] }
  } catch {
    return { items: [] }
  }
}

/** 记一笔「自动顶掉了什么」——可查、可照着加回来，但**不进墓碑**（那不是主人删的）。 */
function recordEvicted(dir, file, list) {
  if (!list || !list.length) return 0
  const { items } = readEvicted(dir)
  const now = Date.now()
  const next = [...items, ...list.map((e) => ({ text: e.text, file, reason: e.reason, at: now }))]
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, EVICTED_FILE), JSON.stringify({ items: next.slice(-EVICTED_MAX) }, null, 2), 'utf-8')
  } catch {
    /* 记不上也不影响腾位 */
  }
  return list.length
}

/**
 * 条目的「信息量」分：带路径/端口/数字/代码/结论的算硬货，泛泛的短句算水。
 * 不是要精确排名，只要能把「DSH 桌面端端口每次都变，别写死 19387」
 * 排到「用户被称作主人」前面就够了。
 */
function entryScore(text) {
  const t = String(text || '')
  let s = Math.min(t.length, 80) / 80 // 长度贡献，封顶
  if (/[A-Za-z]:\\|\/[\w.-]+\/|\\\\/.test(t)) s += 1.4 // 路径
  if (/\b\d{2,}\b|\d+\.\d+/.test(t)) s += 0.5 // 具体数字/端口/版本
  if (/`[^`]+`/.test(t)) s += 0.4 // 行内代码
  if (/→|=>|＝|=/.test(t)) s += 0.2 // 映射关系
  if (/(别|不要|禁止|必须|只能|不能)/.test(t)) s += 0.3 // 规则/禁令
  if (t.length < 16) s -= 0.6 // 太短
  if (/^[^，。；]*$/.test(t) && t.length < 24) s -= 0.4 // 一句话都没有的短语
  return s
}

/**
 * 规划腾位：预算超了 over 个字符时，挑哪几条让位。
 *
 * 顺序（先淘汰谁）：
 *   ① 重复的：跟别的条目 ≥60% 重合，且自己更短（信息更少的那条）
 *   ② 剩下的按信息量从低到高
 * 硬约束：
 *   - 锁定的（.pinned.json）一律不动
 *   - 最后 1 条（最近写进去的）不动
 *   - 一次最多 6 条（防止一刀切光）
 */
function planEviction(entries, overChars, { dir, file, protectText = '' } = {}) {
  const list = entries.map((text, i) => ({ text, i }))
  if (list.length <= 1) return { keep: entries, evicted: [], saved: 0 }

  const protectNorm = protectText ? normForCompare(protectText) : ''
  for (const a of list) {
    let best = 0
    let bestLen = 0
    for (const b of list) {
      if (a === b) continue
      const r = similarityOf(a.text, b.text)
      if (r > best) {
        best = r
        bestLen = b.text.length
      }
    }
    a.sim = best
    a.otherLen = bestLen
    a.score = entryScore(a.text)
    a.dup = best >= 0.6
    // 两条很像时，留长的、淘汰短的
    a.loseDup = a.dup && a.text.length <= a.otherLen
  }

  const lastIdx = list.length - 1
  const candidates = list
    .filter((a) => a.i !== lastIdx)
    .filter((a) => a.text !== protectText)
    .filter((a) => !(protectNorm && normForCompare(a.text) === protectNorm))
    .filter((a) => !(dir && isPinned(dir, a.text, file)))
    .sort((x, y) => {
      if (x.loseDup !== y.loseDup) return x.loseDup ? -1 : 1
      if (x.loseDup && y.loseDup) return x.score - y.score
      return x.score - y.score
    })

  const evicted = []
  const removed = new Set()
  let saved = 0
  for (const c of candidates) {
    if (saved >= overChars && evicted.length > 0) break
    if (evicted.length >= MAX_EVICT_PER_WRITE) break
    evicted.push({
      text: c.text,
      reason: c.loseDup
        ? `跟另一条 ${Math.round(c.sim * 100)}% 重复，且更短`
        : `信息量最低（分 ${c.score.toFixed(1)}）`,
    })
    removed.add(c.i)
    saved += c.text.length + DELIM.length
  }
  return { keep: entries.filter((_, i) => !removed.has(i)), evicted, saved }
}

/**
 * 给提炼 prompt 用的「已知清单」：现有条目 + 删过清单。
 * 两个都截断，别把 prompt 撑爆（这段是额外开销，控制在 2500 字符内）。
 */
function buildKnownContext(cfg) {
  const cap = 2500
  const lines = []
  const u = readStore(cfg.memoryDir, 'USER.md').entries
  const m = readStore(cfg.memoryDir, 'MEMORY.md').entries
  if (u.length || m.length) {
    lines.push('已经记过的条目（不要重复写，也不要换个说法重写）：')
    for (const e of u) lines.push(`- [USER] ${e}`)
    for (const e of m) lines.push(`- [ENV] ${e}`)
  }
  const { items } = readRejected(cfg.memoryDir)
  if (items.length) {
    lines.push('')
    lines.push('用户删掉过的条目（绝对不要再写回来）：')
    for (const it of items.slice(-40)) lines.push(`- ${it.text}`)
  }
  const text = lines.join('\n').trim()
  if (!text) return ''
  return text.length > cap ? `${text.slice(0, cap)}\n…（清单过长已截断）` : text
}

/** 把提炼结果解析成两类条目。 */
export function parseExtract(text) {
  const user = []
  const env = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    // 先剥掉模型爱加的装饰再匹配。2026-10-21 修：原来只认行首直接是 USER:/ENV:，
    // 于是 `- USER: …`、`**USER:** …`、`1. USER: …` 全被静默丢掉，
    // 现象是「提炼完成：USER 0 条 / ENV 0 条」，但模型其实吐了东西。
    const line = raw
      .trim()
      .replace(/^[>*•‣·\-–—]+\s*/, '') // 列表符 / 引用符
      .replace(/^\d+[.、)]\s*/, '') // 编号
      .replace(/\*\*/g, '') // 粗体标记
      .replace(/`/g, '') // 行内代码
      .replace(/^#+\s*/, '') // 标题井号
      .trim()
    if (!line || /^NONE\b/i.test(line)) continue
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
  const done = { user: 0, env: 0, skipped: [], notes: [] }
  for (const [items, target] of [
    [user, 'user'],
    [env, 'memory'],
  ]) {
    for (const item of items) {
      const res = writeMemory(cfg, { target, action: 'add', content: item })
      if (res.ok) {
        if (res.applied?.added) done[target === 'user' ? 'user' : 'env'] += 1
        else if (res.note) done.notes.push(`${target}: ${res.note}`)
      } else {
        done.skipped.push(`${target}: ${String(res.error).slice(0, 80)}`)
      }
    }
  }
  if (done.skipped.length) {
    ctx.logger?.warn?.(
      `[${PLUGIN_NAME}] 自动回填有 ${done.skipped.length} 条没写进去（预算／墓碑／去重）：${done.skipped[0]}`,
    )
    _probe(`自动回填被拦 ${done.skipped.length} 条：${done.skipped.join(' ｜ ').slice(0, 300)}`)
  }
  if (done.notes.length) {
    _probe(`自动回填跳过 ${done.notes.length} 条重复：${done.notes.join(' ｜ ').slice(0, 300)}`)
  }
  if (done.user + done.env > 0) {
    ctx.logger?.info?.(
      `[${PLUGIN_NAME}] 自动回填：USER ${done.user} 条 / ENV ${done.env} 条（跳过 ${done.notes.length + done.skipped.length}）`,
    )
    _probe(`自动回填：USER ${done.user} 条 / ENV ${done.env} 条（跳过 ${done.notes.length + done.skipped.length}）`)
  }
}

/**
 * 按会话记「最近一轮」（2026-10-29 改）。
 *
 * 原来是一个全局 `lastTurnRef`，被最后说话的那个会话覆盖 —— 而 QQ 机器人跟桌面端
 * 在同一个宿主里跑，群消息一来就把它盖掉了。结果主人在自己会话里点「现在提炼」，
 * 抓到的却是 cwd=D:\qqbot 的那一轮，被黑名单拦下，面板还显示「提炼失败」。
 *
 * 现在按 sessionId 分开存，面板点提炼时**优先挑最近一个能提炼的会话**：
 * 机器人那些轮次被黑名单跳过，接着往前找，直到找到主人自己的对话。
 */
const recentTurns = new Map() // sessionId -> { session, event, at, cwd }
const RECENT_TURNS_MAX = 40

function sessionKeyOf(session, event) {
  try {
    const fromHeader = session?.header?.id
    if (fromHeader) return String(fromHeader)
    if (session?.id) return String(session.id)
    const evId = event?.data?.sessionId || event?.sessionId
    if (evId) return String(evId)
  } catch {
    /* 拿不到就用空串 */
  }
  return ''
}

function rememberTurn(session, event) {
  const key = sessionKeyOf(session, event) || `anon-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const { cwd } = sessionMetaOf(session)
  recentTurns.set(key, { session, event, at: Date.now(), cwd })
  if (recentTurns.size > RECENT_TURNS_MAX) {
    const oldest = [...recentTurns.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) recentTurns.delete(oldest[0])
  }
}

/** 最近一轮的引用（保留这个名字：面板「现在提炼」的逻辑还在用）。 */
function pickCapturableTurn(cfg, wantedId = '') {
  if (wantedId && recentTurns.has(wantedId)) {
    const hit = recentTurns.get(wantedId)
    return { ref: hit, id: wantedId, blocked: captureBlockReason(cfg, hit.session) }
  }
  const sorted = [...recentTurns.entries()].sort((a, b) => b[1].at - a[1].at)
  const blocked = []
  for (const [id, ref] of sorted) {
    const why = captureBlockReason(cfg, ref.session)
    if (!why) return { ref, id, blocked: null }
    blocked.push({ id, cwd: ref.cwd, why })
  }
  return { ref: null, id: '', blocked }
}

/**
 * 仅供测试用：清空「最近轮次」表。
 * 生产里不需要（每个宿主进程只 apply 一次），但测试用例之间共享模块级状态，
 * 不清就会把上一个用例的会话带进下一个，导致选中已删除的临时目录。
 */
export function _resetRecentTurns() {
  recentTurns.clear()
}

/** 从 session 上取 cwd / preset（不同版本字段位置不一样，多点兜底）。 */
function sessionMetaOf(session) {
  let header = null
  try {
    header = session?.header || (typeof session?.snapshotHeader === 'function' ? session.snapshotHeader() : null)
  } catch {
    header = null
  }
  return {
    cwd: header?.cwd || session?.cwd || session?.meta?.cwd || '',
    preset: header?.agentPreset || session?.agentPreset || '',
  }
}

/** 这个 cwd 在不在「不参与提炼」的名单里。 */
function isExcludedCwd(cfg, cwd) {
  const list = Array.isArray(cfg.skipCaptureCwds) ? cfg.skipCaptureCwds : []
  if (!list.length || !cwd) return false
  const norm = String(cwd).toLowerCase().replace(/\//g, '\\')
  return list.some((x) => norm.includes(String(x).toLowerCase().replace(/\//g, '\\')))
}

/** 能不能提炼这个会话；返回 null = 能，返回字符串 = 不能的原因。 */
function captureBlockReason(cfg, session) {
  const { cwd, preset } = sessionMetaOf(session)
  if (isExcludedCwd(cfg, cwd)) return `这个会话在工作目录黑名单里（cwd=${cwd}），不提炼`
  if (preset && Array.isArray(cfg.skipPresets) && cfg.skipPresets.includes(preset)) {
    return `这个会话的 preset 在黑名单里（preset=${preset}），不提炼`
  }
  return null
}

function applyAutoCapture(ctx, cfg) {
  let running = false

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    rememberTurn(session, event) // 不管开关，都留着备用（按会话分开记）
    if (!cfg.autoCapture) return

    const blocked = captureBlockReason(cfg, session)
    if (blocked) {
      _probe(`自动回填：${blocked}`)
      return
    }
    if (running) {
      _probe('自动回填：上一轮还在提炼，跳过这一轮')
      return
    }

    const body = renderTurnForCapture(session, event)
    if (!body) {
      _probe('自动回填：这一轮抽不出正文，跳过')
      return
    }

    running = true
    _probe(`自动回填：开始提炼（正文 ${body.length} 字符）`)
    runExtract(EXTRACT_PROMPT(body, buildKnownContext(cfg)), cfg, ctx)
      .then((text) => {
        if (!text) {
          _probe('自动回填：提炼没返回（HTTP 和 headless 都没回话）')
          return
        }
        const parsed = parseExtract(text)
        _probe(`自动回填：解析出 USER ${parsed.user.length} 条 / ENV ${parsed.env.length} 条｜raw=${JSON.stringify(String(text).slice(0, 300))}`)
        if (parsed.user.length === 0 && parsed.env.length === 0) return
        persistExtract(ctx, cfg, parsed)
      })
      .catch((e) => {
        _probe(`自动回填失败：${e?.message || e}`)
        ctx.logger?.warn?.(`[${PLUGIN_NAME}] 自动回填失败：${e.message}`)
      })
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

/**
 * 本插件对外暴露的全部路由名。
 * 用途：面板拿它跟自己的期望比对 —— 前端是新拉的、后端却是进程启动时的旧代码，
 * 这种错配只靠报错（unknown POST /capture）根本看不懂，所以要显式声明能力。
 */
const ROUTES = [
  'state',
  'write',
  'config',
  'capture',
  'dream',
  'models',
  'backups',
  'restore',
  'session',
  'similar',
  'export',
  'import',
  'reindex',
  'sessions',
  'search',
  'pin',
  'wiki',
  'archive',
  'lift',
]

function statePayload(cfg) {
  const rej = readRejected(cfg.memoryDir)
  const pick = pickCapturableTurn(cfg)
  return {
    ok: true,
    version: PLUGIN_VERSION,
    routes: ROUTES,
    autoCapture: cfg.autoCapture !== false,
    memoryDir: cfg.memoryDir,
    modelNote: '自动回填走 HTTP 直调 opencode-go（零会话、不落会话目录）；HTTP 不通才回退 headless，且会删掉它落的会话',
    extractProvider: String(cfg.extractProvider || ''),
    extractModel: String(cfg.extractModel || ''),
    // 细节下沉的现状：归档页里存了多少条（预算紧张时从常驻记忆挪过去的）
    archiveCount: archiveCount(cfg.memoryDir),
    // 自动重建索引的现状（面板显示「每天首次启动自动跑」）
    autoReindex: cfg.autoReindex !== false,
    autoReindexHours: Number(cfg.autoReindexHours) || 24,
    lastReindexAt: readLastReindex(cfg.memoryDir),
    dreamModelProvider: String(cfg.dreamModelProvider || ''),
    dreamModelName: String(cfg.dreamModelName || ''),
    dreamNote: '做梦通道：跨会话离线整理已有记忆。留空 = 跟提炼通道同一个模型',
    // 提炼守卫的现状：墓碑条数 + 不参与提炼的 cwd 名单
    rejectedCount: rej.items.length,
    rejected: rej.items.slice(-20).map((x) => x.text),
    skipCaptureCwds: Array.isArray(cfg.skipCaptureCwds) ? cfg.skipCaptureCwds : [],
    // 面板点「现在提炼」时会抓到哪个会话（自动跳过黑名单里的 qqbot / bili-duty）
    capturableSession: pick.ref ? { session: pick.id, cwd: pick.ref.cwd } : null,
    trackedSessions: recentTurns.size,
    // 锁定与自动腾位的现状（面板据此画锁图标、显示最近顶掉了什么）
    pinnedByFile: pinnedByFile(cfg.memoryDir),
    evictedCount: readEvicted(cfg.memoryDir).items.length,
    evictedRecent: readEvicted(cfg.memoryDir)
      .items.slice(-10)
      .map((x) => ({ text: x.text, file: x.file, reason: x.reason })),
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
        pinned: st.entries.filter((e) => isPinned(cfg.memoryDir, e, f.name)),
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
 * 2026-10-28：算法抽到 similarityOf()，跟墓碑判定共用一份。
 */
function findSimilar(dir, file, text) {
  const target = String(text || '').trim()
  if (target.length < 4) return []
  const out = []
  for (const e of readStore(dir, file).entries) {
    const ratio = similarityOf(target, e)
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

/** 上次自动重建索引的时间（毫秒时间戳；0 = 从未）。 */
function readLastReindex(dir) {
  try {
    const p = path.join(dir, '.last-reindex')
    if (!existsSync(p)) return 0
    return Number(readFileSync(p, 'utf-8').trim()) || 0
  } catch {
    return 0
  }
}

/**
 * 自动重建索引（2026-11-14 加）。
 *
 * 为什么：重建要扫全部会话转录、几分钟，以前必须手动点按钮；
 * 但索引过时会让搜索和做梦拿到旧数据。改成每天第一次启动时后台跑一次。
 *
 * 判据用 <memoryDir>/.last-reindex（不用 cron）：启动时看距上次多久，
 * 超过 autoReindexHours（默认 24h）就跑。这样「每天第一次启动」自然成立，
 * 同一天里反复重开客户端不会重复扫。
 */
function scheduleAutoReindex(ctx, cfg) {
  if (cfg.autoReindex === false) {
    _probe('自动重建索引：已关闭（autoReindex: false）')
    return
  }
  const hours = Number(cfg.autoReindexHours) || 24
  const stampFile = path.join(cfg.memoryDir, '.last-reindex')
  let last = 0
  try {
    if (existsSync(stampFile)) last = Number(readFileSync(stampFile, 'utf-8').trim()) || 0
  } catch {
    last = 0
  }
  const elapsedH = (Date.now() - last) / 3600000
  if (last && elapsedH < hours) {
    _probe(`自动重建索引：距上次 ${elapsedH.toFixed(1)} 小时，不到 ${hours} 小时，跳过`)
    return
  }
  // 后台跑，不阻塞插件装载和应用启动
  _probe(`自动重建索引：距上次 ${last ? elapsedH.toFixed(1) + ' 小时' : '从未'}，开始（后台）`)
  setTimeout(() => {
    try {
      reindex(cfg)
        .then((r) => {
          try {
            writeFileSync(stampFile, String(Date.now()), 'utf-8')
          } catch {
            /* 时间戳写不了不影响索引本身 */
          }
          const tail = String(r?.log || '').split('\n').filter(Boolean).slice(-2).join('；')
          _probe(`自动重建索引完成：${tail || '(无输出)'}`)
          ctx.logger?.info?.(`[${PLUGIN_NAME}] 自动重建索引完成：${tail || ''}`)
        })
        .catch((e) => _probe(`自动重建索引失败：${e?.message || e}`))
    } catch (e) {
      _probe(`自动重建索引启动失败：${e?.message || e}`)
    }
  }, 8000) // 等宿主稳下来再跑，别和启动抢资源
  if (typeof ctx.effect === 'function') {
    // 宿主卸载时不需要取消：dump/build 是独立子进程，跑完自然结束
    ctx.effect(() => () => {}, 'memory-inject.autoReindex')
  }
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
            // 同 runHeadlessExtract：Windows 上要为 .cmd 走 shell。
            // DEP0190 警告可忽略（args 是脚本绝对路径，不是外部输入）。
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
        // 用 PATH 里的 node 跑 dump，不能用 process.execPath：桌面端宿主里它是
        // 带空格的 DeepSeek Harness.exe，shell:true 下 cmd 会把它截断成
        // '...\Programs\DeepSeek' 报「不是内部或外部命令」（2026-11-14 实测）。
        const nodeCmd = process.env.DSH_NODE || 'node'
        const r = await run(nodeCmd, [dumpScript])
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
      // 自动重建现状：面板据此在搜索栏下面说明「每天首次启动会自动跑」
      autoReindex: cfg.autoReindex !== false,
      autoReindexHours: Number(cfg.autoReindexHours) || 24,
      lastReindexAt: readLastReindex(cfg.memoryDir),
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
  // 用 ctx.get()，不能写 ctx.webServer —— 没 inject 的话那句会直接抛错（见 apply 里的说明）。
  const webServer = (() => {
    try {
      return ctx?.get?.('webServer')
    } catch {
      return undefined
    }
  })()
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.(`[${PLUGIN_NAME}] 没有 webServer 服务，设置面板的接口没挂上`)
    return
  }
  const base = '/api/memory-inject'

  ctx.effect?.(
    () =>
      webServer.register({
        kind: 'prefix',
        path: base,
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1')
          const route = url.pathname.slice(base.length) || '/'
          try {
            if (req.method === 'GET' && route === '/state') {
              return sendJson(res, 200, statePayload(cfg))
            }
            // 当前宿主可用的模型目录（给面板「模型选择」下拉用，自动点选不用手打）
            if (req.method === 'GET' && route === '/models') {
              const llm = (() => {
                try {
                  return ctx?.get?.('llm')
                } catch {
                  return undefined
                }
              })()
              if (!llm || typeof llm.listProviders !== 'function') {
                return sendJson(res, 200, { ok: true, providers: [], note: '宿主没有 llm 服务' })
              }
              const list = []
              for (const p of llm.listProviders() || []) {
                const id = p?.id || p?.provider
                if (!id) continue
                let models = []
                try {
                  // 单个 provider 兜住异常 + 5 秒上限：某个 provider 没配 key/网络不通时别拖住面板
                  models = await Promise.race([
                    Promise.resolve(llm.listModels(id)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
                  ])
                } catch {
                  models = []
                }
                list.push({
                  id,
                  name: p?.name || id,
                  models: (Array.isArray(models) ? models : []).map((m) => ({
                    id: m?.id || String(m),
                    name: m?.name || m?.id || String(m),
                  })),
                })
              }
              return sendJson(res, 200, { ok: true, providers: list })
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
              // 模型选择（2026-11-14 加）：面板手动选的模型，存 .settings.json 并立刻生效
              for (const key of ['extractProvider', 'extractModel', 'dreamModelProvider', 'dreamModelName']) {
                if (typeof body[key] === 'string') {
                  patchObj[key] = body[key].trim()
                  cfg[key] = patchObj[key]
                }
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
            //
            // 2026-10-29 改：不再只看「最后说话的那个会话」。QQ 机器人跟桌面端同宿主，
            // 群消息一来就把 lastTurnRef 盖掉，主人在自己会话里点提炼会被自己的黑名单拦下。
            // 现在：带 ?session=<id> 就提炼那个会话；不带就按时间倒序找**最近一个能提炼的**。
            if (req.method === 'POST' && route === '/capture') {
              const wanted = url.searchParams.get('session') || ''
              const picked = pickCapturableTurn(cfg, wanted)
              if (!picked.ref) {
                if (!recentTurns.size) {
                  return sendJson(res, 400, { ok: false, error: '还没抓到可提炼的一轮 —— 先聊一轮再来' })
                }
                const list = picked.blocked || []
                const last = list[0]
                return sendJson(res, 400, {
                  ok: false,
                  error: last
                    ? `最近 ${list.length} 个会话都在提炼黑名单里。最近一个的原因：${last.why}。` +
                      '在你自己的对话里发一条消息再点；要放开就改「记忆」里的 skipCaptureCwds。'
                    : '还没抓到可提炼的一轮 —— 先聊一轮再来',
                  blocked: list,
                })
              }
              const blocked = picked.blocked
              if (blocked) return sendJson(res, 400, { ok: false, error: blocked })
              const body = renderTurnForCapture(picked.ref.session, picked.ref.event)
              if (!body) return sendJson(res, 400, { ok: false, error: '这一轮没有可提炼的内容' })
              const text = await runExtract(EXTRACT_PROMPT(body, buildKnownContext(cfg)), cfg, ctx)
              if (!text) {
                return sendJson(res, 502, {
                  ok: false,
                  error: '提炼没返回 —— HTTP 和 headless 两条路都没回话',
                })
              }
              const parsed = parseExtract(text)
              persistExtract(ctx, cfg, parsed)
              // raw = 模型原始回话（截断）。排查「提炼完成：0 条」用：
              //   回 NONE        → 这一轮确实没新的可记事实，正常
              //   回别的格式     → 解析器没认出来，是 prompt/解析对不上
              //   回空/报错文字  → HTTP 与 headless 都失败了
              return sendJson(res, 200, {
                ok: true,
                ...parsed,
                capturedFrom: { session: picked.id, cwd: picked.ref.cwd, chars: body.length },
                raw: String(text).slice(0, 2000),
                state: statePayload(cfg),
              })
            }

            // 表征层：列主题 / 取某个主题页（面板里看记忆地图）
            if (req.method === 'GET' && route === '/wiki') {
              const topic = url.searchParams.get('topic') || ''
              if (!topic) {
                const topics = listWikiTopics(cfg.memoryDir)
                return sendJson(res, 200, {
                  ok: true,
                  topics: topics.map((t) => {
                    const page = readWikiPage(cfg.memoryDir, t) || ''
                    const first = page.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
                    return { topic: t, summary: first.replace(/^#+\s*/, '').slice(0, 60) }
                  }),
                })
              }
              const page = readWikiPage(cfg.memoryDir, topic)
              return sendJson(res, page ? 200 : 404, page
                ? { ok: true, topic, content: page }
                : { ok: false, error: `没有「${topic}」这个主题` })
            }

            // 做梦整理：跨会话离线核对已有记忆。只做增量，没被提到的条目原样保留。
            if (req.method === 'POST' && route === '/dream') {
              const r = await runDream(ctx, cfg)
              return sendJson(res, r.ok ? 200 : 502, {
                ...r,
                state: r.ok ? statePayload(cfg) : undefined,
              })
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

            // 锁定 / 解锁一条记忆：锁住的条目，预算满了也不会被自动顶掉
            if (req.method === 'POST' && route === '/pin') {
              const body = await readJsonBody(req)
              const file = body.file === 'USER.md' ? 'USER.md' : body.file === 'MEMORY.md' ? 'MEMORY.md' : ''
              const r = setPinned(cfg.memoryDir, {
                text: body.text,
                file,
                pinned: body.pinned !== false,
              })
              return sendJson(res, r.ok ? 200 : 400, { ...r, state: r.ok ? statePayload(cfg) : undefined })
            }
            // 自动腾位的记录（顶掉了什么、为什么）
            if (req.method === 'GET' && route === '/evicted') {
              const { items } = readEvicted(cfg.memoryDir)
              return sendJson(res, 200, { ok: true, count: items.length, items: items.slice(-50) })
            }
            // 归档页：下沉下来的细节（内容没丢，只是从常驻记忆挪到了这里）
            if (req.method === 'GET' && route === '/archive') {
              const page = readWikiPage(cfg.memoryDir, ARCHIVE_TOPIC)
              return sendJson(res, 200, { ok: true, count: archiveCount(cfg.memoryDir), content: page || '' })
            }
            // 从归档取回一条（放回记忆）
            if (req.method === 'POST' && route === '/lift') {
              const body = await readJsonBody(req)
              const text = String(body.text || '').trim()
              if (!text) return sendJson(res, 400, { ok: false, error: 'text 不能为空' })
              const target = body.target === 'user' ? 'user' : 'memory'
              const r = writeMemory(cfg, { target, action: 'add', content: text, force: true })
              if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error })
              liftEntryFromWiki(cfg.memoryDir, text)
              return sendJson(res, 200, { ok: true, lifted: text, state: statePayload(cfg) })
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

// 注意：这里**不要**写 `export default { apply, inject }`。
// 对照能正常工作的插件（dsh-bili-scroll）：它只有命名导出（name / inject / Config / apply），
// 没有 default。多一个 default 会让加载器取到 `mod.default`，而那里没有 name，
// 结果就是模块被 import 了、apply 却永远不被调用。2026-10-21 的最后一个坑。
