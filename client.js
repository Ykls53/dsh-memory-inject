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
    // 诊断用：面板不出现时，看控制台有没有这一行就能判断是「没加载」还是「注册失败」
    try {
      console.log('[dsh-memory-inject] client bundle loaded')
    } catch {
      /* 某些环境没有 console */
    }
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/memory-inject'

    /**
     * 这个面板需要后端提供的能力。
     * 后端插件是在 DSH 进程启动时加载的，改了文件不重载；而前端每次开设置都重新拉。
     * 于是会出现「面板有新按钮、后端是旧代码」——只报 unknown POST /capture 根本看不懂。
     * 拿 /state 的 routes 一比，缺什么当场说清楚。
     */
    const NEEDED_ROUTES = [
      'capture',
      'dream',
      'models',
      'pin',
      'backups',
      'restore',
      'session',
      'similar',
      'export',
      'import',
      'reindex',
      'sessions',
      'search',
    ]

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
      // 必须带 same-origin 凭证：DSH 的 web 接口有鉴权，裸 fetch 会 401
      const r = await fetch(API + path, { credentials: 'same-origin' })
      return r.json()
    }
    async function post(path, body) {
      const r = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
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
    function FileCard({ file, entries, onChange, onSave, onLimit, onRefresh, onPin, busy }) {
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
          : entries.map((text, i) => {
              // 锁定的条目：预算满了也不会被自动顶掉（.pinned.json）
              const locked = (file.pinned || []).includes(text)
              return h(
                'div',
                {
                  key: i,
                  style: {
                    display: 'flex',
                    gap: 8,
                    marginBottom: 8,
                    alignItems: 'flex-start',
                    borderLeft: locked ? '3px solid #d1a343' : '3px solid transparent',
                    paddingLeft: locked ? 6 : 0,
                  },
                },
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
                h(
                  'button',
                  {
                    style: locked ? { ...btn, color: '#d1a343', borderColor: 'rgba(209,163,67,.5)' } : btn,
                    title: locked ? '已锁定：预算满了也不会被自动顶掉，点击解锁' : '锁定这一条（自动腾位时不许动它）',
                    onClick: () => onPin(text, !locked),
                  },
                  locked ? '🔒' : '🔓',
                ),
                h('button', { style: btnDanger, onClick: () => onChange(entries.filter((_, j) => j !== i)) }, '删'),
              )
            }),

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

    // ── 记忆地图页（表征层 wiki）─────────────
    /**
     * wiki 是「记忆地图」：按主题聚合的页面，比记忆条目更适合看全景。
     * 它**不进注入区**（文章警告顶层必须小），模型要用时通过 memory_wiki 工具取。
     * 这一页只是给人看：有哪些主题、每页写了什么。
     */
    function WikiTab() {
      const [topics, setTopics] = useState(null)
      const [open, setOpen] = useState(null) // { topic, content }
      const [msg, setMsg] = useState('')

      useEffect(() => {
        getJson('/wiki')
          .then((r) => {
            if (r && r.ok) setTopics(r.topics || [])
            else setMsg((r && r.error) || '读取失败')
          })
          .catch((e) => setMsg('读取失败：' + e.message))
      }, [])

      const openTopic = async (t) => {
        if (open && open.topic === t) return setOpen(null)
        const r = await getJson('/wiki?topic=' + encodeURIComponent(t))
        if (r && r.ok) setOpen({ topic: t, content: r.content })
        else setMsg((r && r.error) || '打开失败')
      }

      if (!topics) return h('div', { style: { ...muted, padding: 12 } }, msg || '读取中…')
      if (topics.length === 0) {
        return h('div', { style: { ...card, padding: 12 } },
          h('strong', null, '还没有记忆地图'),
          h('div', { style: { ...muted, marginTop: 6 } },
            '跑一轮「做梦整理」会自动把相关条目归拢成主题页（比如「PS5 开发」「记忆插件」）。'),
        )
      }

      return h('div', null,
        h('div', { style: { ...muted, marginBottom: 10 } },
          `${topics.length} 个主题。主题页不进注入区（省 token），模型需要时会自己用 memory_wiki 取。`),
        ...topics.map((t) =>
          h('div', { key: t.topic, style: { ...card, padding: 10, marginBottom: 8 } },
            h('div', {
              style: { cursor: 'pointer', fontWeight: 600 },
              onClick: () => openTopic(t.topic),
            }, (open && open.topic === t.topic ? '▾ ' : '▸ ') + t.topic),
            t.summary ? h('div', { style: { ...muted, marginTop: 3 } }, t.summary) : null,
            open && open.topic === t.topic
              ? h('pre', {
                  style: {
                    marginTop: 8, padding: 8, background: 'rgba(128,128,128,.08)',
                    borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap',
                    maxHeight: 320, overflow: 'auto', fontFamily: 'inherit',
                  },
                }, open.content)
              : null,
          ),
        ),
        msg ? h('div', { style: { ...muted, marginTop: 6 } }, msg) : null,
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
            h('button', { style: btn, disabled: busy, onClick: rebuild, title: '每天第一次启动会自动重建；这个按钮是手动强制重跑' }, '立即重建'),
          ),
          h('div', { style: { ...muted, whiteSpace: 'pre-wrap' } },
            data
              ? `共 ${data.total} 个会话，其中 ${data.withSummary} 个有摘要${msg ? '　·　' + msg : ''}`
              : (msg || '读取中…')),
          // 自动重建说明：不用再点了，每天第一次启动会自己跑
          data && data.autoReindex !== false
            ? h('div', { style: { ...muted, marginTop: 4 } },
                `索引每天第一次启动时自动重建（每 ${data.autoReindexHours || 24} 小时最多一次）` +
                (data.lastReindexAt
                  ? `　·　上次：${new Date(data.lastReindexAt).toLocaleString('zh-CN')}`
                  : '　·　还没自动跑过'))
            : null,
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
      const [models, setModels] = useState({ extractProvider: '', extractModel: '', dreamModelProvider: '', dreamModelName: '', providers: null })
      // 模型选择默认收起：面板顶部只留一行摘要，点「模型 ⚙」才展开
      const [showModelCfg, setShowModelCfg] = useState(false)

      const load = useCallback(async () => {
        const [st, mp] = await Promise.all([getJson('/state'), getJson('/models').catch(() => null)])
        if (!st || st.ok === false) {
          setMsg('加载失败：' + (st && st.error ? st.error : '接口没响应'))
          return
        }
        setData(st)
        const d = {}
        for (const f of st.files || []) d[f.name] = [...(f.entries || [])]
        setDraft(d)
        setModels({
          extractProvider: st.extractProvider || '',
          extractModel: st.extractModel || '',
          dreamModelProvider: st.dreamModelProvider || '',
          dreamModelName: st.dreamModelName || '',
          providers: (mp && mp.ok ? mp.providers : []) || [],
        })
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

      /** 保存手动选的模型（提炼 + 做梦），存 .settings.json 并立刻生效。 */
      const saveModels = async () => {
        setBusy(true)
        try {
          const r = await post('/config', {
            extractProvider: models.extractProvider,
            extractModel: models.extractModel,
            dreamModelProvider: models.dreamModelProvider,
            dreamModelName: models.dreamModelName,
          })
          if (r.ok) {
            if (r.state) setData(r.state)
            setMsg('模型选择已保存并生效')
          } else setMsg('保存模型失败：' + (r.error || ''))
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
        // 说清要抓哪一份：抓的是 cwd，不是「最后说话的那个会话」（可能是 QQ 机器人）
        const target = data.capturableSession?.cwd
        setMsg(target ? `提炼最近一轮（${target}）…` : '提炼最近一轮…')
        try {
          const r = await post('/capture', {})
          if (r.ok) {
            if (r.state) setData(r.state)
            const from = r.capturedFrom?.cwd ? `（来源 ${r.capturedFrom.cwd}）` : ''
            setMsg(`提炼完成：USER ${r.user.length} 条 / ENV ${r.env.length} 条${from}`)
            await load()
          } else setMsg('提炼失败：' + (r.error || ''))
        } finally {
          setBusy(false)
        }
      }

      /** 做梦：无感执行——只做增量，没被提到的条目原样保留，不需要主人确认。 */
      const dreamNow = async () => {
        setBusy(true)
        setMsg('做梦整理中…')
        try {
          const r = await post('/dream?dry=0', {})
          if (!r.ok) {
            setMsg('做梦失败：' + (r.error || ''))
            return
          }
          if (r.state) setData(r.state)
          await load()
          if (!r.changed) {
            setMsg(r.note || '做梦完成：没有需要改的')
          } else {
            const sk = (r.skipped || []).length ? `（拦下 ${r.skipped.length} 处：${r.skipped[0]}）` : ''
            setMsg(`做梦完成：${(r.applied || []).join('；')}${sk}`)
          }
        } finally {
          setBusy(false)
        }
      }

      /** 锁定 / 解锁一条：锁住的条目在预算满时不会被自动顶掉。 */
      const togglePin = async (fileName, text, pinned) => {
        setBusy(true)
        try {
          const r = await post('/pin', { file: fileName, text, pinned })
          if (r.ok) {
            if (r.state) setData(r.state)
            setMsg(`${pinned ? '已锁定' : '已解锁'}：${String(text).slice(0, 30)}`)
            await load()
          } else setMsg('锁定失败：' + (r.error || ''))
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

      // 前后端错配检测：后端没声明的能力，直接点名让用户重启
      const backendRoutes = Array.isArray(data.routes) ? data.routes : []
      const missing = NEEDED_ROUTES.filter((r) => !backendRoutes.includes(r))
      const staleBanner =
        missing.length > 0
          ? h(
              'div',
              {
                style: {
                  ...card,
                  borderColor: 'rgba(220,140,20,.55)',
                  background: 'rgba(220,140,20,.08)',
                  padding: 12,
                  marginBottom: 12,
                },
              },
              h('strong', null, '后端插件是旧版本，先重启客户端'),
              h('div', { style: { ...muted, marginTop: 4 } },
                '面板已经是最新的，但服务端仍停在 DSH 启动时加载的那份代码。' +
                '下面这些功能现在点了会 404：'),
              h('div', { style: { ...muted, marginTop: 2, fontFamily: 'monospace' } }, missing.join('　')),
              h('div', { style: { ...muted, marginTop: 4 } },
                '关掉 DeepSeek Harness 重新打开即可（不必清缓存）。'),
            )
          : null

      // 按 provider 分组（照刷B站插件的 optgroup 做法）：
      // 平铺二三十项 + 每项带完整 provider 名 = 一坨，分组后一眼就找到。
      const modelGroups = (models.providers || [])
        .map((p) => ({
          id: p.id,
          label: p.name && p.name !== p.id ? p.name : p.id,
          models: (p.models || []).map((m) => ({
            key: p.id + '|' + m.id,
            // 组里已经有 provider 名了，选项只留型号，不再重复
            label: m.id,
            hint: m.name && m.name !== m.id ? m.name : '',
          })),
        }))
        .filter((g) => g.models.length > 0)
      const modelOpts = []
      for (const g of modelGroups) for (const m of g.models) modelOpts.push(m)
      const extractValue = (() => {
        if (!models.extractModel) return ''
        const hit = modelOpts.find((o) => o.key.endsWith('|' + models.extractModel))
        return hit ? hit.key : 'cur|' + models.extractModel
      })()
      const dreamValue = models.dreamModelProvider && models.dreamModelName
        ? models.dreamModelProvider + '|' + models.dreamModelName
        : ''

      return h(
        'div',
        { style: { padding: '4px 2px', fontSize: 13 } },

        staleBanner,

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
          tabBtn('memory', '常驻记忆'),
          tabBtn('wiki', '记忆地图'),
          tabBtn('sessions', '会话摘要'),
          h('span', { style: { ...muted, marginLeft: 'auto' } },
            tab === 'memory' ? '第 1 层' : (tab === 'wiki' ? '表征层' : '第 2 / 3 层')),
          h('span', { style: muted }, data.version ? `v${data.version}` : ''),
        ),

        tab === 'memory'
          ? h(
              'div',
              null,
              // ── 工具条：状态 + 所有操作都收在这一行里，不再往下堆卡片 ──
              h(
                'div',
                { style: { ...card, marginBottom: 10, padding: 10 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('button', {
                    style: data.autoCapture ? btnPrimary : btn,
                    disabled: busy,
                    onClick: () => toggleAuto(!data.autoCapture),
                    title: '开着一轮结束就自动提炼事实写回',
                  }, data.autoCapture ? '自动总结 · 开' : '自动总结 · 关'),
                  h('button', { style: btn, disabled: busy, onClick: captureNow }, '提炼一轮'),
                  h('button', { style: btn, disabled: busy, onClick: dreamNow }, '做梦整理'),
                  h('div', { style: { flex: 1 } }),
                  h('button', {
                    style: showModelCfg ? { ...btn, background: 'rgba(47,111,237,.12)' } : btn,
                    onClick: () => setShowModelCfg(!showModelCfg),
                  }, '模型 ⚙'),
                ),
                // 一行摘要：现在用的是谁，一眼看见，不用展开、不用往下滚
                h('div', { style: { ...muted, marginTop: 6 } },
                  `提炼 ${models.extractModel || '默认'}　·　做梦 ${models.dreamModelName || '跟提炼'}`),
                h('div', { style: { ...muted, marginTop: 2 } },
                  data.capturableSession
                    ? `「提炼一轮」会抓：${data.capturableSession.cwd || '(未知目录)'}`
                    : '「提炼一轮」暂时没抓到可提炼的会话 —— 先在你自己的对话里发一条'),
              ),

              // 模型选择：默认收起，点「模型 ⚙」才展开，不占视线
              showModelCfg
                ? h(
                    'div',
                    { style: { ...card, marginBottom: 10, padding: 10 } },
                    h('div', { style: { ...muted, marginBottom: 6 } },
                      '从当前客户端可用模型里点选，改完点保存立刻生效。'),
                    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
                      h('span', { style: { width: 64, flex: 'none' } }, '提炼'),
                      h('select', {
                        style: { ...input, flex: 1, minWidth: 0 },
                        value: extractValue,
                        onChange: (e) => {
                          const v = e.target.value
                          const i = v.indexOf('|')
                          setModels({
                            ...models,
                            extractProvider: i > 0 ? v.slice(0, i) : '',
                            extractModel: i >= 0 ? v.slice(i + 1) : v,
                          })
                        },
                      },
                        h('option', { value: '' }, '默认'),
                        extractValue.startsWith('cur|')
                          ? h('option', { value: extractValue }, extractValue.slice(4) + '（当前）') : null,
                        ...modelGroups.map((g) =>
                          h('optgroup', { key: 'eg-' + g.id, label: g.label },
                            ...g.models.map((m) => h('option', { key: m.key, value: m.key }, m.label)))),
                      ),
                    ),
                    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
                      h('span', { style: { width: 64, flex: 'none' } }, '做梦'),
                      h('select', {
                        style: { ...input, flex: 1, minWidth: 0 },
                        value: dreamValue,
                        onChange: (e) => {
                          const v = e.target.value
                          const i = v.indexOf('|')
                          setModels({
                            ...models,
                            dreamModelProvider: i > 0 ? v.slice(0, i) : '',
                            dreamModelName: i > 0 ? v.slice(i + 1) : '',
                          })
                        },
                      },
                        h('option', { value: '' }, '跟提炼同一个'),
                        dreamValue && !modelOpts.some((o) => o.key === dreamValue)
                          ? h('option', { value: dreamValue }, dreamValue.replace('|', ' / ') + '（当前）') : null,
                        ...modelGroups.map((g) =>
                          h('optgroup', { key: 'dg-' + g.id, label: g.label },
                            ...g.models.map((m) => h('option', { key: 'd-' + m.key, value: m.key }, m.label)))),
                      ),
                    ),
                    models.providers === null
                      ? h('div', { style: muted }, '模型列表读取中…')
                      : (models.providers.length === 0
                        ? h('div', { style: muted }, '宿主没列出可用模型 —— 可先用默认。') : null),
                    h('button', { style: btnPrimary, disabled: busy, onClick: saveModels }, '保存'),
                  )
                : null,

              // 预算满了自动顶掉的是哪些（锁定的不动）；没有就不显示
              (data.evictedRecent || []).length > 0
                ? h('div', { style: { ...card, marginBottom: 10, borderColor: 'rgba(209,163,67,.45)' } },
                    h('strong', null, '最近自动顶掉的条目'),
                    h('div', { style: { ...muted, marginTop: 4, marginBottom: 6 } },
                      '预算到顶时才会动；锁🔒的条目不会被顶。要恢复就照着下面原文加回去。'),
                    ...(data.evictedRecent || []).slice(-5).map((e, i) =>
                      h('div', { key: i, style: { ...muted, marginTop: 2 } },
                        `· [${e.file || '?'}] ${String(e.text || '').slice(0, 60)}　—　${e.reason || ''}`),
                    ),
                  )
                : null,

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
                  onPin: (text, pinned) => togglePin(f.name, text, pinned),
                }),
              ),

              h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
                h('button', { style: btn, onClick: doExport }, '导出 JSON'),
                h('button', { style: btn, onClick: doImport }, '导入 JSON'),
              ),
              h('div', { style: { ...muted, marginTop: 4 } },
                msg || `记忆目录：${data.memoryDir || ''}　·　上限自己定，改完立刻生效`),
            )
          : (tab === 'wiki' ? h(WikiTab) : h(SessionsTab)),
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
