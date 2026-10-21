// dsh-memory-dump.mjs — 把 DSH 全部会话转录（多帧 zstd）解压成可入库的 JSONL
//
// 复刻 Hermes 记忆架构的 L2/L3 层素材准备：
//   L3 全量原文 = DSH 会话转录本身（逐帧解压后取 user/assistant 文本）
//   L2 会话描述 = DSH 自带的 session/title 记录 + 首条用户消息
//
// 复用 read-dsh-session.mjs 的 RFC 8878 逐帧解析（DSH 转录是多帧追加的，
// 整体解压只能拿到第一帧约 203 字节的会话头）。
//
// 用法:
//   node dsh-memory-dump.mjs                                  # 全量，输出 ~/.dsh/memories/dump.jsonl
//   node dsh-memory-dump.mjs --project --D-deepseekDAIGirlfriend--   # 只跑一个项目
//   node dsh-memory-dump.mjs --incremental                     # 只处理有变化的会话
//
// 输出每行一个 JSON，三种 t 值：
//   {"t":"session","id","project","cwd","preset","createdAt","mtime"}
//   {"t":"title","session","title"}
//   {"t":"msg","session","role","time","text"}

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

if (typeof zlib.zstdDecompressSync !== 'function') {
  console.error('需要 Node 22.15+ / 23+ 的 zstd 支持（node:zlib.zstdDecompressSync）');
  process.exit(1);
}

// ── 参数 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
let root = path.join(os.homedir(), '.dsh', 'sessions');
let outPath = path.join(os.homedir(), '.dsh', 'memories', 'dump.jsonl');
let onlyProject = null;
let incremental = false;
const MAX_TEXT = 4000;   // 单条正文上限，防工具输出/长文把库灌爆

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') root = argv[++i];
  else if (a === '--out') outPath = argv[++i];
  else if (a === '--project') onlyProject = argv[++i];
  else if (a === '--incremental') incremental = true;
}

// ── zstd 逐帧解析（RFC 8878）───────────────────────────
function frameEnd(b, pos) {
  let p = pos;
  if (b.readUInt32LE(p) !== 0xFD2FB528) return -1;
  p += 4;
  const fhd = b[p]; p += 1;
  const fcsFlag = (fhd >> 6) & 3;
  const singleSeg = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!singleSeg) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  if (fcsFlag === 0) { if (singleSeg) p += 1; }
  else p += [0, 2, 4, 8][fcsFlag];
  while (true) {
    const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >> 3;
    if (type === 0 || type === 2) p += size;
    else if (type === 1) p += 1;
    else return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

function decompressAll(file) {
  const buf = readFileSync(file);
  const outs = [];
  let pos = 0;
  while (pos < buf.length) {
    const end = frameEnd(buf, pos);
    if (end < 0 || end <= pos) break;
    try { outs.push(zlib.zstdDecompressSync(buf.subarray(pos, end))); }
    catch { break; }
    pos = end;
  }
  return Buffer.concat(outs).toString('utf8');
}

// ── 记录 → 纯文本 ───────────────────────────────────────
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => {
    if (typeof c === 'string') return c;
    if (c?.type === 'text') return c.text || '';
    if (c?.type === 'image') return '[图片]';
    return '';
  }).filter(Boolean).join('\n');
}

// ── 扫描 ────────────────────────────────────────────────
if (!existsSync(root)) { console.error(`会话根目录不存在: ${root}`); process.exit(1); }
mkdirSync(path.dirname(outPath), { recursive: true });

const cachePath = path.join(os.homedir(), '.dsh', 'memories', '.dump-cache.json');
let cache = {};
if (incremental && existsSync(cachePath)) {
  try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
}
const nextCache = {};

const projects = readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .filter(d => !onlyProject || d.name === onlyProject);

const out = [];
let nSessions = 0, nMsgs = 0, nSkipped = 0, nFail = 0;

for (const proj of projects) {
  const projDir = path.join(root, proj.name);
  let sessions = [];
  try { sessions = readdirSync(projDir, { withFileTypes: true }).filter(d => d.isDirectory()); }
  catch { continue; }

  for (const sd of sessions) {
    const zPath = path.join(projDir, sd.name, 'session.v4.jsonl.zstd');
    if (!existsSync(zPath)) continue;
    let st;
    try { st = statSync(zPath); } catch { continue; }
    const key = `${proj.name}/${sd.name}`;
    nextCache[key] = st.mtimeMs;

    if (incremental && cache[key] === st.mtimeMs) { nSkipped++; continue; }

    let text;
    try { text = decompressAll(zPath); }
    catch (e) { console.error(`[!] 解压失败 ${key}: ${e.message}`); nFail++; continue; }

    const lines = text.split(/\r?\n/);
    let header = null;
    let title = null;
    const msgs = [];

    for (const line of lines) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const t = obj.type;
      const d = obj.data || {};

      if (t === 'session') {
        header = {
          id: obj.id || d.id || sd.name.replace(/^session-/, ''),
          cwd: obj.cwd ?? d.cwd ?? null,
          preset: obj.agentPreset ?? d.agentPreset ?? null,
          createdAt: obj.createdAt ?? null,
        };
      } else if (t === 'session/title') {
        // DSH 自带会话标题，优先取最后一次写入
        const v = d.title ?? d.text ?? d.value ?? (typeof d === 'string' ? d : null);
        if (typeof v === 'string' && v.trim()) title = v.trim();
      } else if (t === 'user/message' && d.source !== 'system') {
        const body = textOf(d.content).trim();
        if (body) msgs.push({ role: 'user', time: obj.time ?? null, text: body });
      } else if (t === 'assistant/message') {
        const body = textOf(d.message?.content ?? d.content).trim();
        if (body) msgs.push({ role: 'assistant', time: obj.time ?? null, text: body });
      }
    }

    const sid = header?.id || sd.name.replace(/^session-/, '');
    out.push(JSON.stringify({
      t: 'session', id: sid, project: proj.name,
      cwd: header?.cwd ?? null, preset: header?.preset ?? null,
      createdAt: header?.createdAt ?? null, mtime: st.mtimeMs,
    }));
    if (title) out.push(JSON.stringify({ t: 'title', session: sid, title }));
    for (const m of msgs) {
      out.push(JSON.stringify({
        t: 'msg', session: sid, role: m.role, time: m.time,
        text: m.text.length > MAX_TEXT ? m.text.slice(0, MAX_TEXT) + '…' : m.text,
      }));
      nMsgs++;
    }
    nSessions++;
  }
}

writeFileSync(outPath, out.join('\n') + '\n', 'utf8');
if (incremental) writeFileSync(cachePath, JSON.stringify(nextCache), 'utf8');

console.error(`[dump] 会话 ${nSessions} 个｜消息 ${nMsgs} 条｜跳过 ${nSkipped}｜失败 ${nFail}`);
console.error(`[dump] 输出 ${outPath}（${out.length} 行）`);
