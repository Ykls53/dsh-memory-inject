# dsh-memory-inject

**给 DeepSeek Harness 加一套「记得住」的记忆：三层，一处也不用你操心。**

大多数 agent 记忆插件只做检索：把对话存成流水账，下次靠语义搜索捞回来。
这套东西做的是三件事叠在一起 —— 短的常驻、中的会攒、长的能翻。

> Three-layer memory for DeepSeek Harness: always-on curated facts (`USER.md` /
> `MEMORY.md`), per-session summaries, and full-text recall over every past
> session. Injection costs zero model calls; the auto-capture layer uses
> whatever model you've already picked in the UI.

---

## 四层是什么

```
第 1 层  常驻注入   USER.md + MEMORY.md              每个会话开头自动在场
                   ↓ 一轮结束时提炼新事实写回
第 2 层  会话摘要   每段对话 2~3 句，进 index.db      问「上周三聊了啥」先看这里
                   ↓ 命中的那条会话可以下钻
第 3 层  全量原文   所有会话正文 + FTS5 trigram 索引   真正想翻细节时用
                   
侧  面  记忆地图   wiki/<主题>.md                    按主题归拢的要点页（做梦维护）
                   ↑ 注入里只带一行主题索引，正文靠 memory_wiki 取
```

| | 第 1 层 | 第 2 层 | 第 3 层 | wiki |
|---|---|---|---|---|
| 存什么 | 提炼过的事实条目 | 每会话摘要 | 对话原文 | 主题化要点页 |
| 花模型吗 | 注入不花；写回才花 | 建索引时花 | **不花** | 做梦时花 |
| 谁维护 | 模型自动回填 / 你手动改 | 索引脚本 | 索引脚本 | 做梦 |
| 预算 | USER 1375 / MEMORY 2200 字符（硬上限） | 无 | 无 | 注入只带 600 字符索引 |

**为什么短的必须有硬上限**：第 1 层每个会话都要整份进上下文。它一旦膨胀，
每个会话都在为「上次写的一堆废话」付 token。所以超预算直接拒绝写入，不截断、不偷偷丢。

**为什么 wiki 不进注入区**：Anthropic 那篇文章讲得很清楚——注入的错笔记会污染每一个会话，
而且指令越长模型越不照做。所以 wiki 正文留在磁盘上，注入里只放一行主题名当「地图入口」，
模型真需要细节时才用 `memory_wiki` 取整页。实测该做法下注入只有 283 字符。

具体多少钱，见下面[「这套东西的开销」](#这套东西的开销粗算)那张表。

## 记忆地图（表征层 wiki）

对齐 Anthropic《The components of agent memory》里「dreaming 构建表征」那一节。
文章实测：**纯搜索 53%，搜索 + wiki 61%**，而且每题省约 2 万 token——因为 wiki 是地图，
模型顺着主题走比盲搜快。

**它是什么**：`<memoryDir>/wiki/<主题>.md`，一个主题一页，由做梦时自动归拢生成。
比如「PS5 开发」一页汇总文件传输风险、编译坑；「记忆插件」一页汇总架构决策。

**为什么不在注入区里**：文章明确警告两件事——注入的错笔记会污染每一个会话；
指令越长模型越不照做。所以：

| | 处理方式 |
|---|---|
| 注入区 | 只放一行主题索引（默认 ≤600 字符），告诉模型「有哪些主题」 |
| 正文 | 留在磁盘，模型要用时调 `memory_wiki('主题')` 取整页 |
| 搜索 | `memory_search` 命中时附带 `relatedWiki`，等于「链接」 |

**怎么让它长**：跑「做梦整理」。模型会把相关条目归拢成主题页，主题页里可以写
`相关：另一个主题名` 做链接。文章有个反面教训——wiki 做得太细会「比原文还大」，
那等于没抽象，所以 prompt 里限制一个主题 15 行内。

**面板**：「记忆地图」页签能看有哪些主题、点开看整页。

## 访问频率调优

对齐文章那句「持续核查全部记忆不现实，应该把做梦集中在容易变的信息上，
或者**按记忆被访问的频率来调做梦节奏**」。

- 每注入一次，给那一批条目记一次 `n`（次数）和 `at`（最近时间）
- 做梦时按 **`log2(1+n) × 2 + 距上次核对天数 / 10`** 排序，分高的排前面
- 核对完（哪怕结论是「无变化」）标 `checked`，下次排后面
- 统计存在 `<memoryDir>/.usage.json`，**不进记忆正文、不占注入预算**，超 500 条自动裁

效果实测：高频 + 久未核对的条目排第一，刚核对过的沉底。这样每轮做梦的算力
优先花在真在用的记忆上，而不是每次都把全部条目过一遍。

## 细节下沉

对齐文章那句「顶层必须保持相对小， dreaming 的很大一部分工作就是保持它小
——**把一些细节移到层级下方，只留下链接**」。

以前是「预算满了就顶掉最差的条目」= **直接丢**。现在改成两步：

1. 先把要腾位置的条目**挪进归档页** `wiki/归档.md`
2. 挪成功才从记忆里移除（挪不动才真顶掉，且会在返回里说明）

效果（实测）：`记忆 6→5 条，归档页 122 字符`——预算腾出来了，内容一个字没丢。
归档页会自动出现在 WIKI 索引里，模型随时能用 `memory_wiki('归档')` 翻到。
面板 `/archive` 能看到归档了什么，`/lift` 能把某条取回记忆。

## 它给你的三个工具

模型自己就能调，不用你开口教：

| 工具 | 干什么 |
|---|---|
| `memory_search` | 搜过去：关键词 + 可选时间窗（`7d` / `24h` / `2w`）。按**会话**聚合返回标题、时间、命中片段、该会话摘要。问「上周三聊了什么」用的就是它。命中时还会附带 `relatedWiki`（相关的记忆地图主题） |
| `memory_remember` | 记下来：`add` / `remove` / `replace` / `batch`。`batch` 可以在一次调用里先删旧的再加新的，**预算只算最终结果**（快满时能先瘦身再写） |
| `memory_wiki` | 读**记忆地图**：不填 `topic` 列出所有主题，填了就取该主题的整页。比 `memory_search` 更适合看全景（一个主题的要点、结论、相关主题链接） |

写入有两条硬规矩：`replace` 的匹配必须唯一命中（多条命中就拒绝，不猜着改）；
写前自动备份到 `<memoryDir>/.backup/`，只留最近 20 份。

## 全自动回填

一轮对话结束（`turn/end`）→ 把这一轮喂给一个一次性 agent 提炼 → 按 `USER:` / `ENV:` 分类写回文件。

**用哪个模型？你自己的那个。** 它 spawn 的是 `dsh --profile headless`，
而这个 agent 读 `~/.dsh/settings.yaml` 的 `agent-default-model` ——
就是设置里模型选择器写的那个字段。你在 UI 里换成 OAI，它就用 OAI；换别的就跟着换。插件不碰你的 key。

默认**关**。开法二选一：设置面板里点一下，或 `cordis.patch.yml` 里 `autoCapture: true`。

递归保护：提炼子进程带 `DSH_MEMORY_INJECT_SUMMARIZE=1`，插件见到这个标记直接退出，
免得「提炼出来的会话」又被抓一遍，无限循环。

## 做梦通道（跨会话离线整理）

对齐 Anthropic《The components of agent memory》里的 **dreaming**：提炼负责从新会话里
**采集**新事实，做梦负责拿历史转录当依据，**核对 / 纠正 / 合并 / 删改**已有的第 1 层记忆。

```
提炼回填  一轮结束 → 从「这一轮」挑新事实写回     （采集）
做梦整理  手动/定时 → 拿历史转录核对已有条目       （整理）
```

**怎么用**：设置面板「常驻记忆」页签点 **做梦整理**。全程无感，不需要确认。它会：

1. 读现有 `USER.md` / `MEMORY.md` 的全部条目（每条带编号）；
2. 按每条的关键词，从第 3 层转录索引（`index.db`）里捞相关片段当核对依据；
3. 让模型**只报操作**，不许复述全文：
   - `FIX 编号 => 改写后的内容`（只改被点名那条的错处）
   - `DROP 编号`（只删被证明错了/过时的那条）
   - `ADD USER: / ADD ENV: 新内容`
   - 没要改的就回 `NONE`
4. 代码拿原文逐条执行，写回文件（写前自动备份）。

**为什么只报操作、不整份重写**（2026-11-14 两次血的教训）：原来让模型输出「整理后的完整清单」，
代码整份覆盖 —— 模型不可能逐字复述几十条原文，漏抄一条、压缩一条就抹掉了主人的记忆。
实际发生过两次：7 条 USER 被压成 386 字符、9 条 MEMORY 被砍成 5 条，都靠 `.backup` 才救回。
**现在没被点名的条目原封不动，从根上不可能丢记忆**；另外还有兜底：一轮要删掉超过 40% 的条目
就被拦下不写。

**模型选择**（照刷B站插件的 provider + model 双字段，设置面板里是从宿主模型目录**点选**的下拉，不用手打）：

**提炼通道走哪条**（按配置自动选，前面的通则后面不跑）：

| 条件 | 通道 | 说明 |
|---|---|---|
| `extractProvider` + `extractModel` 都填了 | **宿主 llm 服务** | 用主人在客户端选的那个模型，插件不管 key。**推荐** |
| 只有 `extractModel` | HTTP 直调 opencode-go | 需要有效 OpenCode Go 订阅，否则 403 |
| 都没有 | headless 会话 | 慢，但只要有 DSH 就能跑 |

做梦用 `dreamModelProvider` / `dreamModelName` 单独覆盖，留空就跟提炼通道。

| 配置 | 默认 | 说明 |
|---|---|---|
| `dreamModelProvider` | `''` | `'opencode-go'`（HTTP 直调）/ `'headless'`（走 headless 会话）/ 留空（先 HTTP 再回退 headless） |
| `dreamModelName` | `''` | 留空 = 跟提炼通道同一个模型（`extractModel`）；填了就覆盖 |

provider 填不认的值会被忽略并跟随提炼通道，日志里会标注（跟刷B站插件的 ignored 标注一致）。

> 注：与提炼回填不同，做梦**不采集新事实**，只整理已有记忆。两者各司其职，别混。

## 设置面板

装完在「设置」左侧多一项 **记忆**（排在「刷B站」后面），两个页签。

**常驻记忆（第 1 层）**

| 功能 | 说明 |
|---|---|
| 自动总结开关 | 开了立刻生效，不用重启 |
| 现在提炼最近一轮 | 不等自动，手动跑一次；结果写回并刷新列表 |
| 条目增删改 | 逐条编辑、删除、添加；**字符上限自己定**（数字框，改完立刻生效） |
| 相似检测 | 加之前先跟已有条目比双字组重合度，像的就提示「合并还是照加」 |
| 历史回滚 | 列出 `.backup/` 里最近 10 份，点一下恢复（恢复前会先把当前内容也备一份） |
| 导出 / 导入 | 导出 JSON 留档或换机器；导入可选「合并（只加没有的）」或「整份覆盖」 |

**会话摘要（第 2 / 3 层）**

| 功能 | 说明 |
|---|---|
| 会话列表 | 最近 60 个：标题 / 时间 / 消息数 / 摘要 |
| 搜索 | 走同一套 FTS5，和模型调的 `memory_search` 一个逻辑 |
| 点标题展开原文 | 下钻第 3 层，直接看该会话完整对话 |
| 重建索引 | 一个按钮跑 dump + build，不用记命令 |

面板改的开关和上限存在 `<memoryDir>/.settings.json`，优先级高于 `cordis.patch.yml` ——
所以面板是「运行时开关」，patch 是「出厂默认」。

## 这套东西的开销（粗算）

假设注入内容 3000 字符、每轮都带、自动回填全开，**100 轮对话**的量级：

| 项 | 每次 | 100 轮 |
|---|---|---|
| 注入 | 3000 字符 ≈ **1875 tokens** | 约 188k tokens |
| 自动回填 | 一轮对话（≤6000 字符≈3750）+ prompt + 输出 ≈ **4200 tokens** | 约 420k tokens |
| **合计** | 约 6.1k tokens/轮 | **约 610k tokens** |

**折算成钱**：61 万 token 按 ¥1/百万 token 粗算 ≈ **0.61 元**（100 轮，含注入 + 自动回填全开）。

只看注入那一档（188k token）就更便宜，且注入命中前缀缓存时按缓存档计价（约 ¥0.2/百万量级），
实际可能只有标价的十分之一。

⚠️ 这是**理论量级，不是账单**：单价随模型和时段变，没算你的对话本身波动，
也没算 cache miss 的比例。要准就看你平台账单，别拿这张表当报销依据。

大约相当于「每轮多花一轮对话本身的 15~25%」。想省：关掉自动回填省 2/3；
把回填改成隔几轮一次再省 80%；注入压到 1500 字符再减半。
注入部分命中前缀缓存的话，实际计价会比表里便宜不少。

## 安装

```bash
# npm（发布后）
dsh plugin --profile desktop add dsh-memory-inject

# 本地路径（开发时）
dsh plugin --profile desktop add /path/to/dsh-memory-inject
```

装完 `dsh` 会自动登记进 `profile/package.json` 的 `dsh.profile.bundles` 并应用自带的
`cordis.patch.yml`。**开个新会话生效**（不必整个客户端重启）。

## 记忆文件

默认 `~/.dsh/memories/`：

```
~/.dsh/memories/
├── USER.md        用户是谁：称呼、脾气、偏好、反感（预算 1375 字符）
├── MEMORY.md      环境事实：路径、端口、坑、命令（预算 2200 字符）
├── index.db       第 2/3 层的索引（由脚本生成）
└── .backup/       每次写入前的自动备份
```

格式是硬性的：**一行一条，条目之间单独一行 `§`**，不要标题、不要段落。

```markdown
要求回答直接、只讲事实：反感公文腔、空话客套。

§

改配置前先备份、留回退命令；改完跑自检全绿才重启。
```

`§` 不是为了好看：它让后来更新记忆的（人也好、模型也好）能**按条目增删**，
而不是整份重写 —— 整份重写迟早丢东西。

## 建索引（第 2/3 层）

**默认自动跑**：每天第一次启动客户端时，插件在后台自动跑一遍 dump + build
（距上次满 `autoReindexHours`（默认 24）小时才跑，同一天反复重开不会重复扫）。
面板「会话摘要」页会显示上次自动跑的时间；想手动强制重跑点「立即重建」。

判据存在 `<memoryDir>/.last-reindex`，不想自动跑就配 `autoReindex: false`。

插件只**查**索引，不建索引。要手动建，用 `scripts/` 里两个脚本：

```bash
# 1) 把 DSH 所有会话转录（多帧 zstd）解压成 JSONL
node scripts/dsh-memory-dump.mjs

# 2) 建 FTS5 trigram 索引 → ~/.dsh/memories/index.db
python scripts/dsh-memory-index.py build

# 可选：给每个会话写 2~3 句摘要（要模型，慢）
python scripts/dsh-memory-index.py search "关键词"      # 验证一下
```

**为什么用 trigram 不用默认分词**：默认的 `unicode61` 不支持中文（实测查询返回空），
`trigram` 对中文精确命中（`QQ机器人` 一查就中）。整份索引 200 多个会话约 30 MB。

**摘要那一步可以跳过** —— 第 1 层和第 3 层不依赖它，跳过只是少了「一眼看全会话」的目录视图。

## 配置

写在 profile 的 `cordis.patch.yml` 里，用 id `memory-inject` 覆盖：

| 配置 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | `~/.dsh/memories` | 记忆目录 |
| `files[].maxChars` | USER 1375 / MEMORY 2200 | 每份文件的硬预算 |
| `maxTotalChars` | 4000 | 单次注入的总预算，超出的文件整份跳过 |
| `turns` | `[]` | 空 = 每轮检查去重；填 `[1]` = 只第一轮 |
| `includePreamble` | `true` | 是否带「这是记忆不是新输入」的说明行 |
| `skipPresets` | `['qqbot', 'qqbot-c2c']` | **这些 preset 的会话不注入**（见下） |
| `onlyPresets` | `[]` | 只在这些 preset 上注入；空 = 不限。配了就优先于 `skipPresets` |
| `autoCapture` | `false` | 全自动回填开关 |
| `captureTimeoutMs` | 180000 | 提炼子进程超时 |
| `extractProvider` | `''` | 提炼走哪条 provider 路由；和 `extractModel` 一起填则走宿主 llm 服务 |
| `dreamModelProvider` | `''` | 做梦通道走哪条通道：`opencode-go` / `headless` / 留空（先 HTTP 再回退） |
| `dreamModelName` | `''` | 做梦用的模型；留空 = 跟提炼通道同一个模型 |
| `dreamSnippetChars` | 6000 | 喂给做梦的转录片段总预算（字符） |
| `autoReindex` | `true` | 每天第一次启动自动重建索引 |
| `autoReindexHours` | 24 | 两次自动重建的最小间隔（小时） |

### 为什么默认排除 qqbot

DSH 的插件挂在**进程**上，不是挂在某个会话上。QQ 机器人（`im-qqbot`）跟桌面端跑在同一个进程里，
而 `agent/pre-step` 是**全局钩子**——不给过滤条件的话，你自己的 `USER.md` / `MEMORY.md`
会被塞进每一段 QQ 聊天里，对面的人不该看到你的私人画像。

判据是 `agent.session.header.agentPreset`（session 的 header 里存着这个会话用的 preset id）。

但 `agent/pre-step` 的事件里**只有 messages/turn/step/signal，没有 agent 也没有 session**
（cordis 的 `dispatch` 没传 `thisArg`，监听器拿不到上下文）。所以走了一条曲线：

```
system-prompt/assemble   ← 这里带 context.agent，能读到 agentPreset
        ↓ （同一个 turn，紧邻触发）
agent/pre-step           ← 记下的 preset 在这里比对，命中 skipPresets 就直接返回
```

时间窗 200ms：两个事件之间只隔一个 await，窗外的旧值不认，避免多会话串台。

改法：

```yaml
# 恢复「所有会话都注入」
- id: memory-inject
  config:
    skipPresets: []

# 反过来：只让指定的 preset 用记忆
- id: memory-inject
  config:
    onlyPresets: ['dafayu']
```

**拿不到 preset 时放行** —— 宁可多注入，也不因为读不出标识就把记忆整个关掉。

## 设计上的取舍（说清楚，别踩）

- **注入的是消息，不是 system prompt。** DSH 插件能通过 `agent/pre-step` 往 messages 里加东西，
  改不了 system prompt。所以这份记忆以一条带 `plugin:dsh-memory-inject` 标记的用户消息出现 ——
  效果等价（都进上下文、都在场），但它在消息列表里可见，不是隐形的系统指令。
- **注入零模型调用。** 读文件、拼字符串，没有 LLM、没有 embedding、没有网络。
- **会话级判断，不是每轮无脑注入。** 每轮 `pre-step` 算一次注入内容的指纹（sha1 短哈希）：
  优先查 agent 的会话历史——历史里已有同指纹就**一个字不动**（不重复堆）；历史里没有
  （首次/被压缩）就**补注入**；指纹变了（文件改了）就注入新基线（最新内容在场）。
  拿不到 agent 时退化用「sessionId → 指纹」的会话级缓存兜底。
- **改文件当轮就生效，但缓存友好性让位给实时性。** 中途改了 USER.md / MEMORY.md，下一轮
  pre-step 发现指纹变了就注入新基线，提示跟着更新（代价：前缀缓存命中率会掉一点）。
- **回填失败一律静默 + 记日志。** 记忆是锦上添花，不该有资格弄崩一次对话。

## 装完先自检

不用开 DSH 界面，一条命令验完所有端点：

```bash
node selfcheck.mjs
```

它用真实插件代码起一个临时 HTTP 服务，把面板要用的每个端点打一遍（读类打你的真实记忆目录，
写类只在临时目录里跑，**绝不碰真实文件**），最后报 `18 通过 / 0 失败`。

## 踩过的坑（写下来省得再踩）

**1. 前端是新的，后端可能是旧的。**
插件服务端在 DSH 进程启动时加载并缓存，改文件不会重载；而设置面板每次打开都重新拉前端。
于是会出现「面板上有新按钮，点下去 404 `unknown POST /capture`」这种莫名其妙的状态。

所以 `/state` 会返回 `version` 和 `routes`（它实际支持的路由清单）。面板拿自己的需求一比，
缺什么就在顶部亮黄条：「后端插件是旧版本，先重启客户端」，并列出哪几个功能现在不能用。
**看到这条黄条就关掉 DeepSeek Harness 重开，不用清缓存。**

**2. `session_summaries.created_at` 是「摘要写入时间」，不是「会话发生时间」。**
摘要表里那个字段记的是提炼那一刻的时间戳。想按会话日期筛，必须 join `sessions` 表取
`sessions.created_at`（毫秒时间戳，别拿秒级去套）。

**3. 空会话不会有摘要。**
`msg_count = 0` 的会话本来就没内容可提炼，报「N 个会话只有 M 条摘要」时这是正常的，不是失败。

**4. cordis 的 `inject` 是硬依赖，不是「有就用」。**
`export const inject = ['webServer']` 写在插件顶层，意思是「这些服务全部就绪，才准调我的 `apply()`」。
只要有一个服务没就绪，fibre 就永远停在 `PENDING`，`apply()` 一次都不会执行，
而且**完全静默**——模块顶层照跑、你的探针只有「模块已加载」一行，现象和「插件根本没被加载」一模一样。

更坑的是服务是**晚一步**就绪的：实测本插件 `apply()` 那一刻 `webServer`/`tools` 都还是 `false`，
约 4 秒后别的插件才拿到。所以别在 `apply()` 里用 `ctx.get()` 赌它已经有了。

正解：
```js
export const inject = []                    // 主 apply 不阻塞
ctx.inject(['webServer'], (sub) => {...})   // 等就绪再挂，cordis 保证
```

**5. `ctx` 是代理，读没声明的服务属性会直接抛。**
```
Error: cannot get property "webServer" without inject
```
`ctx.webServer`、`ctx.tools.register(...)` 这种写法在 `inject = []` 下**当场炸**——连你写的探针都会炸。
一律用 `ctx.get('webServer')`：取不到返回 `undefined`，不抛错。

**6. Windows 上 `spawn` 多行 prompt 会被 cmd.exe 截断。**
`dsh` 在 Windows 上是 `.cmd` 壳，`spawn` 它必须 `shell: true`，而 shell 走的是 `cmd.exe` ——
**cmd.exe 把换行当成命令分隔符**。多行 prompt 塞进 argv，只有第一行成了位置参数，
后面的内容全丢（实测只送进去 42 个字符，模型回「没有内容」）。

这个坑伪装得极像「解析器坏了」：明明有对话，提炼结果永远是 0 条。
正解是走 stdin：

```js
const child = spawn('dsh', ['--profile', 'headless'], {
  shell: true, stdio: ['pipe', 'pipe', 'pipe'],
})
child.stdin.end(prompt, 'utf8')   // prompt 不进命令行，换行随便
```

（试过并不可行的：直接 spawn `DeepSeek Harness.exe` + `cli.js` 绕开 shell —— 完全没输出；
让模型读临时文件 —— headless profile 里没有 `tool-fs`；把换行换成空格 —— body 上限 6000 会顶到 cmd 的 8191。）

**7. 开发时别拿主 profile 当试验台 —— 用 headless / web profile 做沙盒。**
插件代码装进 profile 的 `node_modules` 之后，**改文件不会热重载**，必须重启客户端才生效。
但重启是有代价的（见下），而且如果你正跑在宿主进程里，重启等于把调试会话也一起杀掉。

DSH 桌面端每次启动都会给 `127.0.0.1` 写一条登录 cookie，名字形如
`dsh-auth-<sha256("127.0.0.1:随机端口")>`、有效期 400 天。**名字带随机端口 ⇒ 旧 cookie 永不覆盖、每次启动永久多一条**
（约 223 字节）。攒到约 70 条（≈15.8KB）就撑爆宿主 16KB 请求头上限，宿主回 `431`，
外壳报 `desktop welcome: Web authentication failed` —— **桌面端直接打不开**。
（这是 DSH 自身的设计缺陷，不是你插件的锅，但反复重启会亲手把它攒到爆点。）

所以分层验证，把主 profile 留到最后一次：

| 层 | 能验什么 | 怎么做 |
|---|---|---|
| ① 离线 | 单测、端到端、cordis 事件模拟 | `node --test test/*.test.js`；`new Context()` 后 `root.plugin(mod)`，手工 `waterfall('agent/pre-step', …)` |
| ② headless 沙盒 | 真 DSH 加载、`apply` 被调用、钩子注册、工具注册、**子进程链路** | 装进 headless profile，`dsh --profile headless "测试"` |
| ③ web 沙盒 | 要 `webServer` 的面板 HTTP 接口 | 装进 web profile，起网页端（`127.0.0.1:3080`） |
| ④ 主 profile | 只为最终生效 | `dsh plugin --profile <主> add <tgz>` + **一次**重启 |

②③ 用的是独立进程或独立 profile，完全不碰你正在用的客户端。
实测 ② 能一路验到「自动回填 → 解析出 N 条 → raw 内容」，覆盖了本插件绝大多数故障面。

⇒ 攒一批改动一次重启；重启前先把当前进展写进交接文件，别让会话断了丢线索。

## 测试

```bash
npm test
```

**68 个用例，全部离线**（不需要装进 DSH）：

- `test/inject.test.js`（15）— 注入、会话缓存（同会话指纹不变不注入 / 指纹变了注入 / 不同会话重注入）、会话历史（同指纹不注入 / 压缩后补注入）、空目录、目录不存在、预算守门、step 过滤、turn 白名单、拒绝分支
- `test/store.test.js`（9）— 条目往返、预算拒绝、原子批量、remove 未命中整批失败、patch 唯一性、写前备份、重复不加
- `test/api.test.js`（16）— 面板每个端点真调一遍：state / write / config / backups / restore（含路径穿越拦截）/ similar / export / import / sessions / search / session / capture / 404
- `test/guard.test.js` — 提炼守卫（墓碑、相似度、黑名单）
- `test/dream.test.js`（6）— 做梦通道的 parseDream 解析

## 回退

```bash
dsh plugin --profile desktop remove dsh-memory-inject
```

记忆文件不受影响，删不删随你。

## 许可

MIT
