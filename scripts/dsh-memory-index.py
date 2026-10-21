# dsh-memory-index.py — 复刻 Hermes 记忆架构的 L2/L3 层：会话索引 + 全文检索
#
# 设计来源（逆向 Hermes Agent 实测）：
#   L2 会话描述 = 会话自带 title + 首条用户消息 + 末条助手回复（bookends），不调模型
#   L3 全量原文 = 会话转录逐条正文，FTS5 trigram 索引，不调模型
#   核心结论：Hermes 整套记忆一次 LLM 都不调用 → 这是它「开销小、无感」的真正原因
#
# 为什么用 trigram 而不是 unicode61：
#   unicode61 不支持中文分词（实测查询返回空），trigram 对中文精确命中（实测 QQ机器人 一查就中）。
#
# 用法:
#   python tools/dsh-memory-index.py build                 # 从 ~/.dsh/memories/dump.jsonl 建库
#   python tools/dsh-memory-index.py search "上周QQ机器人"  # 全文检索，按会话聚合
#   python tools/dsh-memory-index.py search "逆向" -k 5 --after 7d
#   python tools/dsh-memory-index.py sessions -k 15        # 列最近会话（L2 目录视图）
#   python tools/dsh-memory-index.py stats

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

HOME = os.path.expanduser('~')
DUMP = os.path.join(HOME, '.dsh', 'memories', 'dump.jsonl')
DB = os.path.join(HOME, '.dsh', 'memories', 'index.db')


def connect(db_path=DB, readonly=False):
    if readonly:
        return sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


# ── build ───────────────────────────────────────────────
SCHEMA = """
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS chunks_fts;

CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    project     TEXT,
    cwd         TEXT,
    preset      TEXT,
    created_at  INTEGER,
    title       TEXT,
    first_user  TEXT,
    last_reply  TEXT,
    msg_count   INTEGER
);

CREATE TABLE chunks (
    id          INTEGER PRIMARY KEY,
    session_id  TEXT,
    role        TEXT,
    kind        TEXT,          -- title | msg
    ts          INTEGER,
    text        TEXT
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text, content='chunks', content_rowid='id', tokenize='trigram'
);
"""


def cmd_build(args):
    dump = args.dump
    if not os.path.exists(dump):
        print(f'[!] 找不到 {dump}，先跑 node tools/dsh-memory-dump.mjs', file=sys.stderr)
        return 1

    sessions, titles = {}, {}
    msgs = []
    with open(dump, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            t = o.get('t')
            if t == 'session':
                sessions[o['id']] = o
            elif t == 'title':
                titles[o['session']] = o['title']
            elif t == 'msg':
                msgs.append(o)

    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = connect()
    conn.executescript(SCHEMA)

    # 会话元数据 + bookends
    agg = {}
    for m in msgs:
        sid = m['session']
        a = agg.setdefault(sid, {'n': 0, 'first_user': None, 'last_reply': None, 'ts': []})
        a['n'] += 1
        if m.get('ts') is not None:
            a['ts'].append(m['ts'])
        if m['role'] == 'user' and a['first_user'] is None:
            a['first_user'] = m['text']
        if m['role'] == 'assistant':
            a['last_reply'] = m['text']

    rows_s, rows_c = [], []
    for sid, meta in sessions.items():
        a = agg.get(sid, {})
        rows_s.append((
            sid, meta.get('project'), meta.get('cwd'), meta.get('preset'),
            meta.get('createdAt'), titles.get(sid),
            (a.get('first_user') or '')[:300],
            (a.get('last_reply') or '')[:300],
            a.get('n', 0),
        ))
    conn.executemany(
        'INSERT INTO sessions (id,project,cwd,preset,created_at,title,first_user,last_reply,msg_count)'
        ' VALUES (?,?,?,?,?,?,?,?,?)', rows_s)

    for m in msgs:
        rows_c.append((m['session'], m['role'], 'msg', m.get('ts'), m['text']))
    for sid, title in titles.items():
        sess = sessions.get(sid, {})
        rows_c.append((sid, '-', 'title', sess.get('createdAt'), title))

    conn.executemany(
        'INSERT INTO chunks (session_id,role,kind,ts,text) VALUES (?,?,?,?,?)', rows_c)
    conn.execute("INSERT INTO chunks_fts(rowid, text) SELECT id, text FROM chunks")
    conn.commit()

    conn.execute('CREATE INDEX IF NOT EXISTS i_chunks_session ON chunks(session_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS i_sessions_created ON sessions(created_at)')
    conn.commit()

    n_msgs = conn.execute('SELECT count(*) FROM chunks WHERE kind="msg"').fetchone()[0]
    n_titles = conn.execute('SELECT count(*) FROM chunks WHERE kind="title"').fetchone()[0]
    print(f'[build] 库 {DB}')
    print(f'[build] 会话 {len(rows_s)} 个｜消息 {n_msgs} 条｜标题 {n_titles} 条')
    conn.close()
    return 0


# ── 查询辅助 ─────────────────────────────────────────────
def parse_after(v):
    """7d / 24h / 2w → 毫秒时间戳下界"""
    if not v:
        return None
    m = re.fullmatch(r'(\d+)\s*([hdw])', v.strip(), re.I)
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2).lower()
    sec = {'h': 3600, 'd': 86400, 'w': 604800}[unit] * n
    return int((datetime.now() - timedelta(seconds=sec)).timestamp() * 1000)


def fmt_ts(ms):
    if not ms:
        return '?'
    try:
        return datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M')
    except Exception:
        return '?'


def session_label(conn, sid):
    r = conn.execute('SELECT title, project, created_at FROM sessions WHERE id=?', (sid,)).fetchone()
    if not r:
        return sid[:8], '?', None
    title, project, created = r
    return (title or '(无标题)'), (project or '?'), created


def cmd_search(args):
    if not os.path.exists(DB):
        print(f'[!] 索引库不存在，先跑 build', file=sys.stderr)
        return 1
    conn = connect(readonly=True)
    q = args.query.strip()
    if not q:
        print('[!] 查询为空', file=sys.stderr)
        return 1

    after_ms = parse_after(args.after)
    use_fts = len(q) >= 2

    if use_fts:
        sql = ('SELECT c.session_id, c.role, c.kind, c.ts, c.text, bm25(chunks_fts) AS rank '
               'FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid '
               'WHERE chunks_fts MATCH ?')
        params = [q.replace('"', '""')]
        # trigram 下短词匹配不到时退化为 q 里每个片段 OR
        try:
            hits = conn.execute(sql + ' ORDER BY rank LIMIT 400', params).fetchall()
        except sqlite3.OperationalError:
            hits = []
        if not hits:
            # 退化：整词短语匹配 / LIKE
            like = f'%{q}%'
            hits = conn.execute(
                'SELECT session_id, role, kind, ts, text, 0 AS rank FROM chunks '
                'WHERE text LIKE ? ORDER BY ts DESC LIMIT 400', (like,)).fetchall()
    else:
        hits = []

    if after_ms:
        hits = [h for h in hits if (h[3] or 0) >= after_ms]

    # 按会话聚合：每会话取最优命中（rank 最小；无 rank 时取最新）
    best = {}
    for sid, role, kind, ts, text, rank in hits:
        cur = best.get(sid)
        key = (rank, -(ts or 0))
        if cur is None or key < cur[0]:
            best[sid] = (key, role, kind, ts, text, rank)

    ranked = sorted(best.items(), key=lambda kv: (kv[1][5], -(kv[1][3] or 0)))
    if not ranked:
        print(f'没有命中「{q}」')
        return 0

    print(f'命中 {len(ranked)} 个会话（显示前 {args.k} 个）｜查询「{q}」\n')
    for sid, (key, role, kind, ts, text, rank) in ranked[:args.k]:
        title, project, created = session_label(conn, sid)
        snippet = text.replace('\n', ' ⏎ ')
        idx = snippet.find(q)
        if idx > 60:
            snippet = '…' + snippet[max(0, idx - 60):idx + 220]
        else:
            snippet = snippet[:280]
        print(f'── {title}')
        print(f'   会话 {sid}')
        print(f'   项目 {project}｜创建 {fmt_ts(created)}｜命中 {fmt_ts(ts)}｜{role}｜{kind}')
        print(f'   {snippet}')
        print()
    conn.close()
    return 0


def cmd_sessions(args):
    if not os.path.exists(DB):
        print('[!] 索引库不存在，先跑 build', file=sys.stderr)
        return 1
    conn = connect()
    conn.executescript(
        'CREATE TABLE IF NOT EXISTS session_summaries ('
        'session_id TEXT PRIMARY KEY, summary TEXT, model TEXT, created_at INTEGER);')
    rows = conn.execute(
        'SELECT s.id, s.title, s.project, s.created_at, s.msg_count, s.first_user, x.summary '
        'FROM sessions s LEFT JOIN session_summaries x ON x.session_id = s.id '
        'ORDER BY s.created_at DESC LIMIT ?', (args.k,)).fetchall()
    print(f'最近 {len(rows)} 个会话（按创建时间倒序）\n')
    for sid, title, project, created, n, first_user, summary in rows:
        fu = (first_user or '').replace('\n', ' ')[:70]
        print(f'{fmt_ts(created)}  {title or "(无标题)"}')
        # L2：有模型摘要就显示摘要，没有才退回首条用户消息
        desc = (summary or fu).replace('\n', ' ')
        print(f'  {sid} ｜ {project} ｜ {n} 条')
        print(f'  描述：{desc[:260]}')
    conn.close()
    return 0


def cmd_stats(args):
    if not os.path.exists(DB):
        print('[!] 索引库不存在，先跑 build', file=sys.stderr)
        return 1
    conn = connect()
    n_s = conn.execute('SELECT count(*) FROM sessions').fetchone()[0]
    n_m = conn.execute('SELECT count(*) FROM chunks WHERE kind="msg"').fetchone()[0]
    n_t = conn.execute('SELECT count(*) FROM chunks WHERE kind="title"').fetchone()[0]
    span = conn.execute('SELECT min(created_at), max(created_at) FROM sessions').fetchone()
    size = os.path.getsize(DB) / 1024 / 1024
    conn.executescript(
        'CREATE TABLE IF NOT EXISTS session_summaries ('
        'session_id TEXT PRIMARY KEY, summary TEXT, model TEXT, created_at INTEGER);')
    n_sum = conn.execute('SELECT count(*) FROM session_summaries').fetchone()[0]
    print(f'会话 {n_s}｜消息 {n_m}｜标题 {n_t}｜模型摘要 {n_sum}')
    print(f'时间跨度 {fmt_ts(span[0])} → {fmt_ts(span[1])}')
    print(f'库体积 {size:.1f} MB  ({DB})')
    print('按项目：')
    for p, c in conn.execute(
            'SELECT project, count(*) FROM sessions GROUP BY project ORDER BY count(*) DESC'):
        print(f'  {c:4d}  {p}')
    conn.close()
    return 0


def main():
    ap = argparse.ArgumentParser(description='DSH 会话记忆索引（复刻 Hermes L2/L3）')
    sub = ap.add_subparsers(dest='cmd', required=True)

    b = sub.add_parser('build')
    b.add_argument('--dump', default=DUMP)
    b.set_defaults(fn=cmd_build)

    s = sub.add_parser('search')
    s.add_argument('query')
    s.add_argument('-k', type=int, default=5)
    s.add_argument('--after', default=None, help='7d / 24h / 2w')
    s.set_defaults(fn=cmd_search)

    ls = sub.add_parser('sessions')
    ls.add_argument('-k', type=int, default=15)
    ls.set_defaults(fn=cmd_sessions)

    st = sub.add_parser('stats')
    st.set_defaults(fn=cmd_stats)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == '__main__':
    sys.exit(main())
