/**
 * 草稿拦截测试：提炼模型会把思考过程当事实写进记忆。
 * 2026-11-14 实测 USER.md 8 条里 5 条是草稿，MEMORY 里还混进过整句英文和残句。
 * 这里锁住判据，防止以后改坏。
 * 跑法：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert'

import { looksLikeDraft } from '../index.js'

test('该拦：自问自答 / 元讨论草稿', () => {
  const drafts = [
    '用户问X？这可能反映偏好，不要输出 USER',
    'This is stable preference? This seems durable',
    '用户说写进技能？已有要求写进提示词，是技能？可能重复。不输出。',
    '值得 ENV? 是环境/项目事实',
    '用户问能不能模拟ps5？这是一次性请求，不算稳定。不输出。',
  ]
  for (const s of drafts) assert.strictEqual(looksLikeDraft(s), true, `应拦：${s}`)
})

test('该拦：整句英文（主人反感记忆里夹英文）', () => {
  assert.strictEqual(
    looksLikeDraft('The memory exclusion rule is a stable configuration pattern - sessions with qqbot must not enter'),
    true,
  )
})

test('该拦：只有个头没内容的残句', () => {
  assert.strictEqual(looksLikeDraft('出网配置'), true)
  assert.strictEqual(looksLikeDraft('端口设置'), true)
})

test('该拦：太短的内容', () => {
  assert.strictEqual(looksLikeDraft('略'), true)
  assert.strictEqual(looksLikeDraft(''), true)
})

test('该拦：代码实现说明（主人点名要删的那类）', () => {
  const impl = [
    '记忆系统 USER 段上限 1375 / MEMORY 段上限 2200，超了拒写。',
    'DSH 记忆系统的 wiki 表征层设计——正文存 <memoryDir>/wiki/ 下，注入区只放索引',
    '访问频率统计存于 .usage.json（记录 n 次数 + at 时间戳），不占注入预算',
    '做梦排序公式 log2(1+n)×2 + 距上次核对天数/10，分高优先核对',
    '排序改变编号对应关系——cur 必须从 numbered 同序重建，否则第 N 条之后全丢',
  ]
  for (const s of impl) assert.strictEqual(looksLikeDraft(s), true, `应拦实现说明：${s.slice(0, 30)}`)
})

test('该拦：任务进展而不是稳定事实', () => {
  const progress = [
    '用户长期维护一个自定义记忆系统，规划了表征层、访问频率调优、细节下沉三项，前两项已完成。',
    '表征层已完成，访问频率待做',
  ]
  for (const s of progress) assert.strictEqual(looksLikeDraft(s), true, `应拦任务进展：${s.slice(0, 30)}`)
})

test('不该拦：正常中文事实', () => {
  const okList = [
    '主人自称「主人」或「伊卡洛斯」',
    '要求回答直接、只讲事实：反感公文腔、空话客套',
    '记忆去重相似度门槛已降到 60%（原 75%）',
    'PS5MM 图片模型与视频模型互斥，切换必须先 free_sd_ctx',
    '冻结窗口打开时不要重启客服端',
  ]
  for (const s of okList) assert.strictEqual(looksLikeDraft(s), false, `不该拦：${s}`)
})

test('不该拦：带英文技术名词但主体是中文', () => {
  const okList = [
    'TacHen 没有 library.stop，无法远程杀 title',
    'PS5SD 编译 404 时设 PS5_OPENGL_SDK 指向本地缓存',
    '用 dsh plugin --profile desktop add 安装',
  ]
  for (const s of okList) assert.strictEqual(looksLikeDraft(s), false, `不该拦：${s}`)
})
