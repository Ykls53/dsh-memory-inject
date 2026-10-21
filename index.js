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

import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

const PLUGIN_NAME = 'dsh-memory-inject'
const SOURCE_KIND = `plugin:${PLUGIN_NAME}`

/** 需要的 DSH 服务；只声明真正用到的，缺了会被框架拦在 apply 之前。 */
export const inject = ['agents']

const DEFAULTS = {
  // 记忆目录；默认 ~/.dsh/memories
  memoryDir: path.join(os.homedir(), '.dsh', 'memories'),
  // 注哪些文件，顺序即注入顺序
  files: [
    { name: 'USER.md', heading: 'USER PROFILE (who the user is)' },
    { name: 'MEMORY.md', heading: 'MEMORY (your personal notes)' },
  ],
  // 注入内容总预算（字符）。超了就按文件顺序截，防把上下文吃穿。
  maxTotalChars: 4000,
  // 只在这些 turn 上注入；空数组 = 每个 turn 都检查（靠 source 标记去重）
  turns: [],
  // 注入时是否打这行说明；关掉只留正文
  includePreamble: true,
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
  const cfg = normalizeConfig(config)
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
}

export default { apply, inject }
