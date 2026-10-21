/**
 * dsh-memory-inject —— 浏览器半端（设置里的「记忆」那一页）
 *
 * client bundle 不是 ESM，是自注册脚本：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 * id 必须等于 package.json 的 name。
 *
 * 进「设置」靠 slots：
 *   slots.inject('settings.section', () => slots.register(
 *     { name: 'settings.section', id, order, label }, () => h(Panel)))
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
      flex: 1,
      padding: '6px 10px',
      borderRadius: 7,
      border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
      fontFamily: 'inherit',
    }
    const muted = { opacity: 0.62, fontSize: 12 }

    async function getState() {
      const r = await fetch(API + '/state')
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

    function FileCard({ file, entries, onChange, onSave, busy }) {
      const [newText, setNewText] = useState('')
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
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 } },
          h('strong', null, file.heading),
          h('span', { style: over ? { ...muted, color: '#d14343' } : muted },
            `${chars} / ${file.maxChars} 字符${over ? '（超预算，保存会被拒）' : ''}`),
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

    function Panel() {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState({})
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        const st = await getState()
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
            setData({ ...data, autoCapture: next })
            setMsg(next ? '自动总结：已开（用 DSH 当前模型）' : '自动总结：已关')
          } else {
            setMsg('改开关失败：' + (r.error || ''))
          }
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
          setMsg(r.ok ? `${fileName} 已保存（${r.chars} 字符）` : `保存失败：${r.error}`)
          if (r.ok) await load()
        } finally {
          setBusy(false)
        }
      }

      if (!data) return h('div', { style: { padding: 16, fontSize: 13 } }, msg || '读取中…')

      return h(
        'div',
        { style: { padding: '4px 2px', fontSize: 13 } },

        // 开关区
        h(
          'div',
          { style: { ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h(
            'div',
            null,
            h('strong', null, '自动总结'),
            h('div', { style: { ...muted, marginTop: 4 } },
              `开着：每轮对话结束自动提炼事实写进下面两份文件。模型跟随 DSH 当前选择 —— ${data.modelNote || ''}`),
          ),
          h('button', {
            style: data.autoCapture ? btnPrimary : btn,
            disabled: busy,
            onClick: () => toggleAuto(!data.autoCapture),
          }, data.autoCapture ? '已开 · 点击关闭' : '已关 · 点击开启'),
        ),

        // 两份文件
        ...(data.files || []).map((f) =>
          h(FileCard, {
            key: f.name,
            file: f,
            entries: draft[f.name] || [],
            busy,
            onChange: (next) => setDraft({ ...draft, [f.name]: next }),
            onSave: () => save(f.name),
          }),
        ),

        h('div', { style: { ...muted, marginTop: 4 } },
          msg || `记忆目录：${data.memoryDir || ''}　·　写进文件后，新会话开头自动注入`),
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
