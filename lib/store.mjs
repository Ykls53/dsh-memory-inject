/**
 * 记忆文件的读写层 —— 对应 Hermes 那套「原子批量写 + 精确 patch + 预算只看最终结果」。
 *
 * 为什么单独一层：
 *   注入只要读，写要背责任。整份重写迟早丢东西，所以这里只做三类写：
 *     1. set   整份覆盖（给面板用，人看得见）
 *     2. patch 精确替换一段文字（改错字、改细节）
 *     3. batch 一次调用里删旧的 + 加新的，预算只算最终结果（满了能先瘦身再写）
 *
 * 铁律：
 *   - 写之前先备份到 <dir>/.backup/，带时间戳
 *   - 预算按最终结果算（不是按操作中间态）
 *   - 超预算直接拒绝，不截断、不静默丢条目（让调用方自己去删）
 *   - 条目格式固定：「一行一条，条目之间单独一行 §」
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import path from 'node:path'

export const DELIM = '\n§\n'

/** 把一个文件的正文拆成条目数组（去掉空条目，保留原顺序）。 */
export function parseEntries(text) {
  if (!text) return []
  return String(text)
    .split(/\n\s*§\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 条目数组 → 文件正文。 */
export function renderEntries(entries) {
  return entries.map((e) => String(e).trim()).filter(Boolean).join(DELIM) + '\n'
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 写前备份，返回备份文件名（没有原文件就不备份）。 */
function backup(dir, file) {
  const target = path.join(dir, file)
  if (!existsSync(target)) return null
  const bdir = path.join(dir, '.backup')
  mkdirSync(bdir, { recursive: true })
  const name = `${file}.bak-${stamp()}`
  copyFileSync(target, path.join(bdir, name))
  return path.join('.backup', name)
}

/** 只保留最近 N 份备份，防止无限堆积。 */
export function pruneBackups(dir, keep = 20) {
  const bdir = path.join(dir, '.backup')
  if (!existsSync(bdir)) return 0
  const files = readdirSync(bdir)
    .filter((f) => f.includes('.bak-'))
    .map((f) => ({ f, m: Number(f.split('.bak-')[1]?.replace(/-/g, '') || 0) }))
    .sort((a, b) => b.m - a.m)
  let removed = 0
  for (const { f } of files.slice(keep)) {
    try {
      unlinkSync(path.join(bdir, f))
      removed++
    } catch {
      /* 删不掉就算了，不影响主流程 */
    }
  }
  return removed
}

/** 读一个记忆文件 → { entries, raw, exists } */
export function readStore(dir, file) {
  const target = path.join(dir, file)
  if (!existsSync(target)) return { entries: [], raw: '', exists: false }
  const raw = readFileSync(target, 'utf-8')
  return { entries: parseEntries(raw), raw, exists: true }
}

/**
 * 落盘。预算检查放在这里统一做：调用方传「最终条目数组」，超了直接拒。
 * @returns {{ok:boolean, entries?:string[], chars?:number, backup?:string, error?:string}}
 */
export function writeStore(dir, file, entries, { maxChars = 4000 } = {}) {
  const body = renderEntries(entries)
  const chars = body.trim().length
  if (chars > maxChars) {
    return {
      ok: false,
      error: `超预算：${chars} > ${maxChars} 字符。先删几条（或调大该文件的 maxChars）再写。`,
      chars,
      maxChars,
    }
  }
  const saved = backup(dir, file)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, file), body, 'utf-8')
  pruneBackups(dir)
  return { ok: true, entries: parseEntries(body), chars, backup: saved }
}

/** 精确替换：oldText 必须唯一命中，否则拒绝（宁可不改，也不猜着改）。 */
export function patchStore(dir, file, { oldText, newText }, opts = {}) {
  const { entries } = readStore(dir, file)
  const hits = entries.filter((e) => e.includes(oldText))
  if (hits.length === 0) return { ok: false, error: '没找到包含 oldText 的条目' }
  if (hits.length > 1) {
    return { ok: false, error: `oldText 命中了 ${hits.length} 条，不唯一；写长一点再试` }
  }
  const next = entries.map((e) => (e === hits[0] ? e.replace(oldText, newText) : e))
  return writeStore(dir, file, next, opts)
}

/**
 * 原子批量：一次调用里删 + 加，预算只看最终结果。
 * @param {{remove?:string[], add?:string[], replace?:{oldText:string,newText:string}[]}} ops
 */
export function batchStore(dir, file, ops = {}, opts = {}) {
  const { entries } = readStore(dir, file)
  let next = [...entries]
  const applied = { removed: 0, added: 0, replaced: 0 }

  for (const needle of ops.remove || []) {
    const before = next.length
    next = next.filter((e) => !e.includes(needle))
    const removed = before - next.length
    if (removed === 0) return { ok: false, error: `remove 没命中任何条目：「${needle}」` }
    applied.removed += removed
  }

  for (const { oldText, newText } of ops.replace || []) {
    const idx = next.findIndex((e) => e.includes(oldText))
    if (idx < 0) return { ok: false, error: `replace 没命中：「${oldText}」` }
    next[idx] = next[idx].replace(oldText, newText)
    applied.replaced++
  }

  for (const text of ops.add || []) {
    const t = String(text).trim()
    if (!t) continue
    if (next.includes(t)) continue // 完全一样的不重复加
    next.push(t)
    applied.added++
  }

  const result = writeStore(dir, file, next, opts)
  return result.ok ? { ...result, applied } : result
}
