/**
 * 自动重建索引的判据测试：每天第一次启动跑，同一天不重复跑。
 * 只测判据逻辑，不真跑 dump/build（那要几分钟）。
 */

import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

function mkDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reindex-'))
  writeFileSync(path.join(dir, 'USER.md'), '画像一条\n', 'utf8')
  writeFileSync(path.join(dir, 'MEMORY.md'), '环境一条\n', 'utf8')
  return dir
}

/** 起一个最小 ctx，返回日志里「自动重建索引」那几行。
 *  注意：_probe 固定写 ~/.dsh/memories/.load.log（不是记忆目录），
 *  所以这里比对「调用前后的差异」，只看本次新增的行。 */
async function bootWith(dir, extraCfg = {}) {
  const probeLog = path.join(os.homedir(), '.dsh', 'memories', '.load.log')
  const readLines = () => {
    try {
      return existsSync(probeLog) ? readFileSync(probeLog, 'utf8').split(/\r?\n/) : []
    } catch {
      return []
    }
  }
  const before = readLines().length
  const ctx = {
    handlers: new Map(),
    on(e, f) { this.handlers.set(e, f) },
    get: () => undefined,
    logger: { info() {}, warn() {} },
    inject: (_d, cb) => { try { cb(ctx) } catch { /* ignore */ } },
    effect: () => {},
  }
  apply(ctx, { memoryDir: dir, ...extraCfg })
  await new Promise((r) => setTimeout(r, 60))
  return readLines().slice(before).filter((l) => l.includes('自动重建索引'))
}

test('从未重建过 → 会触发（后台）', async () => {
  const dir = mkDir()
  try {
    const logs = await bootWith(dir)
    const hit = logs.some((l) => l.includes('从未') || l.includes('开始'))
    assert.ok(hit, `应当触发自动重建，实际日志：${JSON.stringify(logs)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('刚重建过（1 小时前）→ 跳过', async () => {
  const dir = mkDir()
  try {
    writeFileSync(path.join(dir, '.last-reindex'), String(Date.now() - 3600000), 'utf8')
    const logs = await bootWith(dir)
    const skipped = logs.some((l) => l.includes('跳过'))
    assert.ok(skipped, `应当跳过，实际日志：${JSON.stringify(logs)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超过 24 小时 → 再次触发', async () => {
  const dir = mkDir()
  try {
    writeFileSync(path.join(dir, '.last-reindex'), String(Date.now() - 25 * 3600000), 'utf8')
    const logs = await bootWith(dir)
    const hit = logs.some((l) => l.includes('开始'))
    assert.ok(hit, `应当触发，实际日志：${JSON.stringify(logs)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('autoReindex:false → 完全不跑', async () => {
  const dir = mkDir()
  try {
    const logs = await bootWith(dir, { autoReindex: false })
    const off = logs.some((l) => l.includes('已关闭'))
    assert.ok(off, `应当报已关闭，实际：${JSON.stringify(logs)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自定义间隔生效（autoReindexHours: 48）', async () => {
  const dir = mkDir()
  try {
    writeFileSync(path.join(dir, '.last-reindex'), String(Date.now() - 30 * 3600000), 'utf8')
    const logs = await bootWith(dir, { autoReindexHours: 48 })
    const skipped = logs.some((l) => l.includes('跳过'))
    assert.ok(skipped, `30 小时 < 48 小时，应当跳过，实际：${JSON.stringify(logs)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
