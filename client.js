/**
 * dsh-memory-inject —— 浏览器半端（设置里的「记忆」那一页）
 *
 * client bundle 不是 ESM，是自注册脚本：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 * id 必须等于 package.json 的 name。
 *
 * 两个页签：
 *   常驻记忆 —— 条目增删改 / 字符上限自己定 / 历史回滚 / 手动提炼 / 导出导入
 *   会话摘要 —— 第 2 层列表 + 搜索 + 点开看原文（下钻第 3 层）+ 重建索引
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-inject',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/memory-inject'

    const card = { border: '1px solid rgba(128,128,128,.25)', borderRadius: 10, padding: 14, marginBottom: 16 }
    const btn = {
      padding: '5px 12px',
      borderRadius: 7,
      border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: 13,
      whiteSpace: 'nowrap',
    }
    const btnPrimary = { ...btn, background: '#2f6fed', borderColor: '#2f6fed', color: '#fff' }
    const btnDanger = { ...btn, color: '#d14343', borderColor: 'rgba(209,67,67,.4)' }
    const input = {
      padding: '6px 10px',
      borderRadius: 7,
      border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
      fontFamily: 'inherit',
      flex: 1,
    }
    const numInput = { ...input, flex: 'none', width: 78, textAlign: 'right' }
    const muted = { opacity: 0.62, fontSize: 12 }
    const warnBox = { ...card, borderColor: 'rgba(209,67,67,.5)', background: 'rgba(209,67,67,.06)', padding: 12 }

    async function getJson(path) {
      const r = await fetch(API + path)
      return r.json()
    }
    async function post(path, body) {
      const r = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      return r.json()
    }

    // ── 备份历史 ────────────────────────────────────────
    function BackupPanel({ file, onRestored }) {
      const [list, setList] = useState(null)
      const [msg, setMsg] = useState('')
      useEffect(() => {
        getJson('/backups?file=' + encodeURIComponent(file))
          .then((r) => setList(r.backups || []))
          .catch((e) => setMsg('读取失败：' + e.message))
      }, [file])

      const restore = async (name) => {
        if (!window.confirm(`确定用这份备份覆盖 ${file}？\n${name}\n（当前内容会先自动备份一份）`)) return
        const r = await post('/restore', { file, name })
        setMsg(r.ok ? `已恢复：${r.entries} 条 / ${r.chars} 字符` : '恢复失败：' + r.error)
        if (r.ok) onRestored?.()
      }

      if (!list) return h('div', { style: { ...muted, marginTop: 8 } }, msg || '读取历史…')
      if (list.length === 0) return h('div', { style: { ...muted, marginTop: 8 } }, '还没有备份（第一次写入后才会有）')

      return h(
        'div',
        { style: { marginTop: 10, borderTop: '1px dashed rgba(128,128,128,.3)', paddingTop: 10 } },
        h('div', { style: { ...muted, marginBottom: 6 } }, `历史版本（${list.length} 份，最多留 20 份）`),
        ...list.slice(0, 10).map((b) =>
          h('div', { key: b.name, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('span', { style: { fontSize: 12 } }, b.label),
            h('span', { style: muted }, `${b.size} 字节`),
            h('button', { style: { ...btn, padding: '2px 10px', fontSize: 12 }, onClick: () => restore(b.name) }, '恢复这一份'),
          ),
        ),
        msg ? h('div', { style: { ...muted, marginTop: 4 } }, msg) : null,
      )
    }

    // ── 一份记忆文件 ────────────────────────────────────
    function FileCard({ file, entries, onChange, onSave, onLimit, onRefresh, busy }) {
      const [newText, setNewText] = useState('')
      const [limitDraft, setLimitDraft] = useState(String(file.maxChars))
      const [showHistory, setShowHistory] = useState(false)
      const [similar, setSimilar] = useState([])

      useEffect(() => setLimitDraft(String(file.maxChars)), [file.maxChars])

      const chars = entries.join('\n§\n').trim().length
      const over = chars > file.maxChars

      const tryAdd = async () => {
        const t = newText.trim()
        if (!t) return
        // 加之前先查相似 —— 自动回填容易写出「换个说法但意思一样」的条目
        try {
          const r = await getJson('/similar?file=' + encodeURIComponent(file.name) + '&text=' + encodeURIComponent(t))
          if (r.ok && r.similar.length) {
            setSimilar(r.similar)
            return // 先让人看一眼，别直接加
          }
        } catch {
          /* 查不到就直接加，不挡路 */
        }
        onChange([...entries, t])
        setNewText('')
      }

      return h(
        'div',
        { style: card },

        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' } },
          h('strong', null, file.heading),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: over ? { ...muted, color: '#d14343' } : muted },
              `${chars} / ${file.maxChars} 字符${over ? '　超了，保存会被拒' : ''}`),
            h('input', {
              value: limitDraft,
              type: 'number',
              min: 100,
              style: numInput,
              title: '这个文件的上限，自己定，改完立刻生效',
              onChange: (e) => setLimitDraft(e.target.value),
              onBlur: () => {
                const n = Number(limitDraft)
                if (Number.isFinite(n) && n > 0 && n !== file.maxChars) onLimit(n)
              },
            }),
            h('span', { style: muted }, '上限'),
          ),
        ),

        entries.length === 0
          ? h('div', { style: { ...muted, marginBottom: 10 } }, '还没有条目。下面输入框加第一条。')
          : entries.map((text, i) =>
              h(
                'div',
                { key: i, style: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' } },
                h('textarea', {
                  value: text,
                  rows: Math.min(6, Math.max(2, Math.ceil(text.length / 46))),
                  onChange: (e) => {
                    const next = [...entries]
                    next[i] = e.target.value
                    onChange(next)
                  },
                  style: { ...input, resize: 'vertical', lineHeight: 1.5 },
                }),
                h('button', { style: btnDanger, onClick: () => onChange(entries.filter((_, j) => j !== i)) }, '删'),
              ),
            ),

        similar.length > 0
          ? h(
              'div',
              { style: warnBox },
              h('div', { style: { marginBottom: 6 } }, '看着像已经有的条目，要合并还是照加？'),
              ...similar.map((s, i) =>
                h('div', { key: i, style: { ...muted, marginBottom: 4 } }, `· ${s.ratio}% 重合：${s.entry.slice(0, 60)}`),
              ),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                h('button', {
                  style: btn,
                  onClick: () => {
                    const t = newText.trim()
                    onChange([...entries, t])
                    setNewText('')
                    setSimilar([])
                  },
                }, '照加'),
                h('button', { style: btnPrimary, onClick: () => { setSimilar([]) } }, '算了，我改一下'),
              ),
            )
          : null,

        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 10 } },
          h('input', {
            value: newText,
            placeholder: '加一条：一句话，只讲一件事',
            onChange: (e) => setNewText(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                tryAdd()
              }
            },
            style: input,
          }),
          h('button', { style: btn, onClick: tryAdd }, '添加'),
          h('button', { style: btnPrimary, disabled: busy, onClick: onSave }, '保存'),
          h('button', { style: btn, onClick: () => setShowHistory(!showHistory) }, showHistory ? '收起历史' : '历史'),
        ),

        showHistory ? h(BackupPanel, { file: file.name, onRestored: onRefresh }) : null,
      )
    }

    // ── 会话摘要页（第 2 层 + 下钻第 3 层）─────────────
    function SessionsTab() {
      const [data, setData] = useState(null)
      const [q, setQ] = useState('')
      const [hits, setHits] = useState(null)
      const [msg, setMsg] = useState('')
      const [open, setOpen] = useState(null) // { id, detail }
      const [busy, setBusy] = useState(false)

      const loadList = useCallback(() => {
        getJson('/sessions?limit=60')
          .then(setData)
          .catch((e) => setMsg('读取失败：' + e.message))
      }, [])

      useEffect(() => {
        loadList()
      }, [loadList])

      const doSearch = async () => {
        if (!q.trim()) return setHits(null)
        setMsg('搜索中…')
        try {
          const r = await getJson('/search?q=' + encodeURIComponent(q.trim()) + '&limit=8')
          setHits(r)
          setMsg(r.ok ? `命中 ${r.count} 个会话` : '搜索失败：' + r.error)
        } catch (e) {
          setMsg('搜索失败：' + e.message)
        }
      }

      const openSession = async (id) => {
        if (open && open.detail && open.id === id) return setOpen(null)
        setOpen({ id, detail: null })
        const r = await getJson('/session?id=' + encodeURIComponent(id))
        setOpen({ id, detail: r })
      }

      const rebuild = async () => {
        if (!window.confirm('重建索引会扫一遍所有会话转录（几分钟），现在跑？')) return
        setBusy(true)
        setMsg('重建中…')
        try {
          const r = await post('/reindex', {})
          setMsg(r.ok ? '重建完成\n' + (r.log || '') : '重建失败')
          loadList()
        } finally {
          setBusy(false)
        }
      }

      const list = hits && hits.ok ? hits.hits : (data && data.sessions) || []

      return h(
        'div',
        null,
        h(
          'div',
          { style: card },
          h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
            h('input', {
              value: q,
              placeholder: '搜过去：关键词 / 「上周三聊了什么」那种事',
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') doSearch() },
              style: input,
            }),
            h('button', { style: btnPrimary, onClick: doSearch }, '搜索'),
            hits ? h('button', { style: btn, onClick: () => { setHits(null); setMsg('') } }, '回到最近') : null,
            h('button', { style: btn, disabled: busy, onClick: rebuild }, '重建索引'),
          ),
          h('div', { style: { ...muted, whiteSpace: 'pre-wrap' } },
            data
              ? `共 ${data.total} 个会话，其中 ${data.withSummary} 个有摘要${msg ? '　·　' + msg : ''}`
              : (msg || '读取中…')),
        ),

        list.length === 0
          ? h('div', { style: { ...card, ...muted } }, '没有索引数据。点上面「重建索引」，或按 README 手动跑 scripts 里的脚本。')
          : list.map((s, i) => {
              const id = s.id || s.session
              const isOpen = open && open.id === id
              return h(
                'div',
                { key: id || i, style: { ...card, padding: 12 } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6, alignItems: 'baseline' } },
                  h('a', {
                    href: '#',
                    onClick: (e) => { e.preventDefault(); if (id) openSession(id) },
                    style: { fontSize: 13, fontWeight: 600, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' },
                  }, s.title || '(无标题)'),
                  h('span', { style: muted }, s.created || s.matched_at || '')),
                h('div', { style: { ...muted, marginBottom: 6 } },
                  (s.role ? `命中：${s.role}` : '') +
                  (s.msgs !== undefined ? `${s.msgs} 条消息` : '') +
                  (s.project ? `　·　${s.project}` : '')),
                h('div', { style: { fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' } },
                  s.summary || s.snippet || '（无摘要）'),

                isOpen
                  ? h(
                      'div',
                      { style: { marginTop: 10, borderTop: '1px dashed rgba(128,128,128,.3)', paddingTop: 10, maxHeight: 420, overflow: 'auto' } },
                      !open.detail
                        ? h('div', { style: muted }, '读取原文…')
                        : open.detail.ok === false
                          ? h('div', { style: { ...muted, color: '#d14343' } }, '读取失败：' + open.detail.error)
                          : (open.detail.messages || []).map((m, j) =>
                              h('div', { key: j, style: { marginBottom: 8 } },
                                h('div', { style: muted }, `${m.role}　${m.time}`),
                                h('div', { style: { fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' } }, m.text.slice(0, 1200)),
                              ),
                            ),
                    )
                  : null,
              )
            }),
      )
    }

    // ── 主面板 ──────────────────────────────────────────
    function Panel() {
      const [tab, setTab] = useState('memory')
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState({})
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        const st = await getJson('/state')
        if (!st || st.ok === false) {
          setMsg('加载失败：' + (st && st.error ? st.error : '接口没响应'))
          return
        }
        setData(st)
        const d = {}
        for (const f of st.files || []) d[f.name] = [...(f.entries || [])]
        setDraft(d)
      }, [])

      useEffect(() => {
        load().catch((e) => setMsg('加载失败：' + e.message))
      }, [load])

      const toggleAuto = async (next) => {
        setBusy(true)
        try {
          const r = await post('/config', { autoCapture: next })
          if (r.ok) {
            setData(r.state || { ...data, autoCapture: next })
            setMsg(next ? '自动总结：已开（用 DSH 当前模型）' : '自动总结：已关')
          } else setMsg('改开关失败：' + (r.error || ''))
        } finally {
          setBusy(false)
        }
      }

      const setLimit = async (fileName, n) => {
        setBusy(true)
        try {
          const r = await post('/config', { limits: { [fileName]: n } })
          if (r.ok && r.state) setData(r.state)
          setMsg(r.ok ? `${fileName} 上限改成 ${n} 字符` : '改上限失败：' + (r.error || ''))
        } finally {
          setBusy(false)
        }
      }

      const save = async (fileName) => {
        setBusy(true)
        try {
          const r = await post('/write', {
            target: fileName === 'USER.md' ? 'user' : 'memory',
            action: 'set',
            entries: draft[fileName] || [],
          })
          if (r.ok) {
            if (r.state) setData(r.state)
            setMsg(`${fileName} 已保存（${r.chars} 字符）`)
          } else setMsg(`保存失败：${r.error}`)
        } finally {
          setBusy(false)
        }
      }

      const captureNow = async () => {
        setBusy(true)
        setMsg('提炼最近一轮…')
        try {
          const r = await post('/capture', {})
          if (r.ok) {
            if (r.state) setData(r.state)
            setMsg(`提炼完成：USER ${r.user.length} 条 / ENV ${r.env.length} 条`)
            await load()
          } else setMsg('提炼失败：' + (r.error || ''))
        } finally {
          setBusy(false)
        }
      }

      const doExport = async () => {
        const r = await getJson('/export')
        const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'dsh-memory-export.json'
        a.click()
        URL.revokeObjectURL(url)
        setMsg('已导出 dsh-memory-export.json')
      }

      const doImport = () => {
        const el = document.createElement('input')
        el.type = 'file'
        el.accept = 'application/json'
        el.onchange = async () => {
          const f = el.files && el.files[0]
          if (!f) return
          const text = await f.text()
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            return setMsg('这个文件不是合法 JSON')
          }
          const mode = window.confirm('点确定 = 合并（只加没有的）；点取消 = 整份覆盖') ? 'merge' : 'replace'
          const r = await post('/import', { data: parsed, mode })
          setMsg(r.ok ? '导入完成：' + JSON.stringify(r.report) : '导入失败：' + r.error)
          if (r.ok) await load()
        }
        el.click()
      }

      const tabBtn = (id, label) =>
        h('button', {
          key: id,
          style: tab === id ? { ...btnPrimary, marginRight: 8 } : { ...btn, marginRight: 8 },
          onClick: () => setTab(id),
        }, label)

      if (!data) return h('div', { style: { padding: 16, fontSize: 13 } }, msg || '读取中…')

      return h(
        'div',
        { style: { padding: '4px 2px', fontSize: 13 } },

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
          tabBtn('memory', '常驻记忆'),
          tabBtn('sessions', '会话摘要'),
          h('span', { style: { ...muted, marginLeft: 'auto' } }, tab === 'memory' ? '第 1 层' : '第 2 / 3 层'),
        ),

        tab === 'memory'
          ? h(
              'div',
              null,
              h(
                'div',
                { style: { ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
                h(
                  'div',
                  { style: { minWidth: 260, flex: 1 } },
                  h('strong', null, '自动总结'),
                  h('div', { style: { ...muted, marginTop: 4 } },
                    `开着：每轮结束自动提炼事实写回下面两份文件。模型跟随 DSH 当前选择 —— ${data.modelNote || ''}`),
                ),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('button', { style: btn, disabled: busy, onClick: captureNow }, '现在提炼最近一轮'),
                  h('button', {
                    style: data.autoCapture ? btnPrimary : btn,
                    disabled: busy,
                    onClick: () => toggleAuto(!data.autoCapture),
                  }, data.autoCapture ? '已开 · 点击关闭' : '已关 · 点击开启'),
                ),
              ),

              ...(data.files || []).map((f) =>
                h(FileCard, {
                  key: f.name,
                  file: f,
                  entries: draft[f.name] || [],
                  busy,
                  onChange: (next) => setDraft({ ...draft, [f.name]: next }),
                  onSave: () => save(f.name),
                  onLimit: (n) => setLimit(f.name, n),
                  onRefresh: load,
                }),
              ),

              h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
                h('button', { style: btn, onClick: doExport }, '导出 JSON'),
                h('button', { style: btn, onClick: doImport }, '导入 JSON'),
              ),
              h('div', { style: { ...muted, marginTop: 4 } },
                msg || `记忆目录：${data.memoryDir || ''}　·　上限自己定，改完立刻生效`),
            )
          : h(SessionsTab),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'memory-inject', order: 40, label: '记忆' },
            () => h(Panel),
          ),
        )
      },
    }
  },
})
