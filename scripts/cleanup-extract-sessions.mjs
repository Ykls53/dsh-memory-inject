// 清理提炼垃圾会话：只删「首条 user 是提炼提示词」的，留下最近的 N 个，其它一律不碰
import { readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const root = String.raw`C:\Users\Yk\.dsh\sessions\--C-Users-Yk-.dsh-memories--`;
const KEEP = 3;
const APPLY = process.argv.includes('--apply');
const MARK = '你在给一个长期记忆系统做提炼';

function frameEnd(b, pos) {
  let p = pos;
  if (b.readUInt32LE(p) !== 0xFD2FB528) return -1;
  p += 4;
  const fhd = b[p]; p += 1;
  const fcsFlag = (fhd >> 6) & 3, singleSeg = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
  if (!singleSeg) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  if (fcsFlag === 0) { if (singleSeg) p += 1; } else p += [0, 2, 4, 8][fcsFlag];
  while (true) {
    const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    p += 3;
    const last = h & 1, type = (h >> 1) & 3, size = h >> 3;
    if (type === 0 || type === 2) p += size; else if (type === 1) p += 1; else return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

function readAll(file) {
  const buf = readFileSync(file);
  let pos = 0; const outs = [];
  while (pos < buf.length) {
    const end = frameEnd(buf, pos);
    if (end < 0 || end <= pos) break;
    try { outs.push(zlib.zstdDecompressSync(buf.subarray(pos, end))); } catch { break; }
    pos = end;
  }
  return Buffer.concat(outs).toString('utf8');
}

const dirs = readdirSync(root).filter((d) => d.startsWith('session-'));
const info = [];
for (const d of dirs) {
  const full = path.join(root, d);
  let firstUser = '';
  try {
    const text = readAll(path.join(full, 'session.v4.jsonl.zstd'));
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'user/message') {
        firstUser = (o.data?.content || []).map((x) => x.text || '').join('\n');
        break;
      }
    }
  } catch { /* 读不出来就当非垃圾，保留 */ }
  info.push({ dir: d, full, ext: firstUser.includes(MARK), mtime: statSync(full).mtimeMs, head: firstUser.slice(0, 40) });
}

const junk = info.filter((x) => x.ext).sort((a, b) => b.mtime - a.mtime);
const keep = junk.slice(0, KEEP);
const kill = junk.slice(KEEP);
const other = info.filter((x) => !x.ext);

console.log(`总目录 ${info.length}｜提炼会话 ${junk.length}｜非提炼（一律保留）${other.length}`);
console.log(`保留最近 ${KEEP} 个：`);
for (const k of keep) console.log(`  [${new Date(k.mtime).toISOString().slice(0, 16)}] ${k.dir}`);
console.log(`将删除 ${kill.length} 个`);
if (other.length) {
  console.log('非提炼会话（不动）：');
  for (const o of other) console.log(`  ${o.dir} | ${o.head}`);
}

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const listFile = path.join(String.raw`C:\Users\Yk\.dsh\_backup`, `mem-inject-20261028-193521`, `deleted-sessions-${stamp}.txt`);
  writeFileSync(listFile, kill.map((k) => `--C-Users-Yk-.dsh-memories--/${k.dir}\t${new Date(k.mtime).toISOString()}`).join('\n'), 'utf8');
  console.log(`删除名单已存：${listFile}`);
  let n = 0;
  for (const k of kill) {
    try { rmSync(k.full, { recursive: true, force: true }); n += 1; } catch (e) { console.log(`  删不掉 ${k.dir}: ${e.message}`); }
  }
  console.log(`已删除 ${n} 个会话目录`);
}
