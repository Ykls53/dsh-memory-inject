/**
 * dsh-memory-inject —— 浏览器半端（设置里的「记忆」那一页）
 *
 * client bundle 不是 ESM，是自注册脚本：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 * id 必须等于 package.json 的 name。
 *
 * 两个页签：
 *   常驻记忆 —— USER.md / MEMORY.md 的条目增删改 + 每份文件的字符上限（用户自己定，不写死）
 *   会话摘要 —— 第 2 层：最近会话的摘要列表，可搜索、可复制会话 id
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-inject',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/memory-inject'

    const card = {
      border: '1px solid rgba(128,128,128,.25)',
      borderRadius: 10,
      padding: 14,
      marginBottom: 16,
    }
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

    function FileCard({ file, entries, onChange, onSave, onLimit, busy }) {
      const [newText, setNewText] = useState('')
      const [limitDraft, setLimitDraft] = useState(String(file.maxChars))
      useEffect(() => setLimitDraft(String(file.maxChars)), [file.maxChars])

      const chars = entries.join('\n§\n').trim().length
      const over = chars > file.maxChars

      const add = () => {
        const t = newText.trim()
        if (!t) return
        onChange([...entries, t])
        setNewText('')
      }

      return h(
        'div',
        { style: card },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10 } },
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
              title: '这个文件的上限，自己定',
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
                h('button', {
                  style: btnDanger,
                  onClick: () => onChange(entries.filter((_, j) => j !== i)),
                }, '删'),
              ),
            ),

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
                add()
              }
            },
            style: input,
          }),
          h('button', { style: btn, onClick: add }, '添加'),
          h('button', { style: btnPrimary, disabled: busy, onClick: onSave }, '保存'),
        ),
      )
    }

    function SessionsTab() {
      const [data, setData] = useState(null)
      const [q, setQ] = useState('')
      const [hits, setHits] = useState(null)
      const [msg, setMsg] = useState('')

      useEffect(() => {
        getJson('/sessions?limit=60')
          .then(setData)
          .catch((e) => setMsg('读取失败：' + e.message))
      }, [])

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
          ),
          h('div', { style: muted },
            data
              ? `共 ${data.total} 个会话，其中 ${data.withSummary} 个有摘要${msg ? '　·　' + msg : ''}`
              : (msg || '读取中…')),
        ),

        list.length === 0
          ? h('div', { style: { ...card, ...muted } }, '没有索引数据。先在命令行跑 scripts 里的 dump + index（见 README）。')
          : list.map((s, i) =>
              h(
                'div',
                { key: s.id || s.session || i, style: { ...card, padding: 12 } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6 } },
                  h('strong', { style: { fontSize: 13 } }, s.title || '(无标题)'),
                  h('span', { style: muted }, s.created || s.matched_at || '')),
                h('div', { style: { ...muted, marginBottom: 6 } },
                  (s.role ? `命中位置：${s.role}` : '') +
                  (s.msgs !== undefined ? `${s.msgs} 条消息` : '') +
                  (s.project ? `　·　${s.project}` : '')),
                h('div', { style: { fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' } },
                  s.summary || s.snippet || '（无摘要）'),
                h('div', { style: { marginTop: 8 } },
                  h('button', {
                    style: btn,
                    onClick: () => {
                      const id = s.id || s.session || ''
                      try {
                        navigator.clipboard.writeText(id)
                        setMsg('已复制会话 id：' + id)
                      } catch {
                        setMsg('会话 id：' + id)
                      }
                    },
                  }, '复制会话 id'),
                  h('span', { style: { ...muted, marginLeft: 8 } }, (s.id || s.session || '').slice(0, 18))),
              ),
            ),
      )
    }

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
          h('span', { style: { ...muted, marginLeft: 'auto' } }, tab === 'memory' ? '第 1 层' : '第 2 层'),
        ),

        tab === 'memory'
          ? h(
              'div',
              null,
              h(
                'div',
                { style: { ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
                h(
                  'div',
                  null,
                  h('strong', null, '自动总结'),
                  h('div', { style: { ...muted, marginTop: 4 } },
                    `开着：每轮结束自动提炼事实写回下面两份文件。模型跟随 DSH 当前选择 —— ${data.modelNote || ''}`),
                ),
                h('button', {
                  style: data.autoCapture ? btnPrimary : btn,
                  disabled: busy,
                  onClick: () => toggleAuto(!data.autoCapture),
                }, data.autoCapture ? '已开 · 点击关闭' : '已关 · 点击开启'),
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
                }),
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
