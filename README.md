# dsh-memory-inject

**给 DeepSeek Harness 加一套「记得住」的记忆：三层，一处也不用你操心。**

大多数 agent 记忆插件只做检索：把对话存成流水账，下次靠语义搜索捞回来。
这套东西做的是三件事叠在一起 —— 短的常驻、中的会攒、长的能翻。

> Three-layer memory for DeepSeek Harness: always-on curated facts (`USER.md` /
> `MEMORY.md`), per-session summaries, and full-text recall over every past
> session. Injection costs zero model calls; the auto-capture layer uses
> whatever model you've already picked in the UI.

---

## 三层是什么

```
第 1 层  常驻注入   USER.md + MEMORY.md              每个会话开头自动在场
                   ↓ 一轮结束时提炼新事实写回
第 2 层  会话摘要   每段对话 2~3 句，进 index.db      问「上周三聊了啥」先看这里
                   ↓ 命中的那条会话可以下钻
第 3 层  全量原文   所有会话正文 + FTS5 trigram 索引   真正想翻细节时用
```

| | 第 1 层 | 第 2 层 | 第 3 层 |
|---|---|---|---|
| 存什么 | 提炼过的事实条目 | 每会话摘要 | 对话原文 |
| 花模型吗 | 注入不花；写回才花 | 建索引时花 | **不花** |
| 谁维护 | 模型自动回填 / 你手动改 | 索引脚本 | 索引脚本 |
| 预算 | USER 1375 / MEMORY 2200 字符（硬上限） | 无 | 无 |

**为什么短的必须有硬上限**：第 1 层每个会话都要整份进上下文。它一旦膨胀，
每个会话都在为「上次写的一堆废话」付 token。所以超预算直接拒绝写入，不截断、不偷偷丢。

具体多少钱，见下面[「这套东西的开销」](#这套东西的开销粗算)那张表。

## 它给你的两个工具

模型自己就能调，不用你开口教：

| 工具 | 干什么 |
|---|---|
| `memory_search` | 搜过去：关键词 + 可选时间窗（`7d` / `24h` / `2w`）。按**会话**聚合返回标题、时间、命中片段、该会话摘要。问「上周三聊了什么」用的就是它 |
| `memory_remember` | 记下来：`add` / `remove` / `replace` / `batch`。`batch` 可以在一次调用里先删旧的再加新的，**预算只算最终结果**（快满时能先瘦身再写） |

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

插件只**查**索引，不建索引。建索引用 `scripts/` 里两个脚本：

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
- **去重靠 `source.kind`，不靠轮次计数。** 所以上下文被压缩掉之后标记消失，下一轮自动补回 ——
  记忆不会因为上下文满了就没了。
- **写盘不等于当前会话立刻变。** 本会话已经注入过那份快照，新写入下次开会话才读到。这是刻意的：
  中途改记忆不该让本轮的提示跟着抖（前缀缓存友好）。
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

**33 个用例，全部离线**（不需要装进 DSH）：

- `test/inject.test.js`（8）— 注入、去重、空目录、目录不存在、预算守门、step 过滤、turn 白名单、拒绝分支
- `test/store.test.js`（9）— 条目往返、预算拒绝、原子批量、remove 未命中整批失败、patch 唯一性、写前备份、重复不加
- `test/api.test.js`（16）— 面板每个端点真调一遍：state / write / config / backups / restore（含路径穿越拦截）/ similar / export / import / sessions / search / session / capture / 404

## 回退

```bash
dsh plugin --profile desktop remove dsh-memory-inject
```

记忆文件不受影响，删不删随你。

## 许可

MIT
