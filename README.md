# dsh-memory-inject

**给 DeepSeek Harness 加一层「永远在场」的记忆。**

大多数 agent 记忆插件做的是**检索**：先把对话存成流水账，下次靠语义搜索捞回来。
这个插件做的是另一件事：把一小份**结论型事实**在每个会话里直接摆到模型面前，不搜、不等、不花一个 token 去生成。

> Inject `USER.md` / `MEMORY.md` as fixed, always-on memory into DeepSeek Harness
> sessions. No embedding, no retrieval, no LLM call — just curated facts that are
> present from the first step of every session.

---

## 为什么需要它

向量检索型记忆有个天花板：它只能回答「哪段原文提到过 X」。它回答不了
「这个人喜欢怎么被说话」「这台机器改配置前要先跑哪个脚本」——因为答案不是某段原文，
而是一条**经过提炼的结论**。而结论，恰恰是检索最不擅长的东西：你搜它，你得先知道搜什么。

固定注入解决的就是这个：不用搜，一直在。

| | 检索型（memsearch 等） | 本插件 |
|---|---|---|
| 存什么 | 对话原文 / 摘要 | 提炼过的事实条目 |
| 什么时候用 | 想到要搜才用 | 每个会话开头自动在场 |
| 花模型调用吗 | 存的时候要（摘要/嵌入） | **不花** |
| 适合 | 「上周那个方案最后定的是啥」 | 「这人讨厌什么」「这机器有什么坑」 |

两者不冲突，是互补的：一个管**找得到**，一个管**记得住**。

## 工作原理

```
会话开始
  └─ agent/pre-step（每轮第一步模型调用前）
       ├─ 历史里已经有本插件注入的消息？ → 有，跳过
       └─ 没有 → 读 USER.md + MEMORY.md → 拼成一条消息塞进 messages
```

三个关键点：

1. **只挂 `agent/pre-step`**，不碰 system prompt、不装钩子到别的阶段，最小侵入。
2. **靠 `source.kind` 去重**：注入的那条消息带 `plugin:dsh-memory-inject` 标记。
   下一轮先查历史里有没有这个标记——有就不重复塞，所以不会每轮堆积。
3. **上下文被压缩掉之后会自动补回来**：压缩把那条消息删了，标记也就没了，下一轮检测不到就重新注入。
   这是刻意的设计——记忆不该因为上下文满了就消失。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile desktop add dsh-memory-inject

# 从本地路径（开发时）
dsh plugin --profile desktop add /path/to/dsh-memory-inject
```

装完 `dsh` 会自动把它登记进 `profile/package.json` 的 `dsh.profile.bundles`，
并应用插件自带的 `cordis.patch.yml`。**重启 DSH 客户端后生效。**

## 记忆文件放哪

默认读 `~/.dsh/memories/`：

```
~/.dsh/memories/
├── USER.md      用户是谁：称呼、脾气、偏好、反感
└── MEMORY.md    环境事实：路径、端口、配置坑、常用命令
```

格式是硬性的：**一行一条，条目之间用单独一行的 `§` 分隔**，不要标题、不要正文段落。

```markdown
要求回答直接、只讲事实：反感公文腔、空话客套。

§

改任何配置前先备份、留回退命令；改完跑自检全绿才重启。
```

`§` 分隔不是洁癖：它是为了让后来更新记忆的工具（人也好、模型也好）能**按条目增删**，
而不是整份重写——整份重写迟早会丢东西。

## 配置

写在 profile 的 `cordis.patch.yml` 里，用同一个 id 覆盖：

```yaml
- id: memory-inject
  config:
    memoryDir: 'D:\my-memory'      # 换记忆目录，默认 ~/.dsh/memories
    maxTotalChars: 6000            # 注入总量预算（字符），默认 4000
    turns: [1]                     # 只在第 1 轮注入；留空 = 每轮检查（推荐）
    includePreamble: true          # 是否带「这是记忆不是新输入」的说明行
    files:                         # 注哪些文件、按什么标题
      - { name: 'USER.md',   heading: 'USER PROFILE (who the user is)' }
      - { name: 'MEMORY.md', heading: 'MEMORY (your personal notes)' }
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | `~/.dsh/memories` | 记忆文件目录 |
| `files` | USER.md / MEMORY.md | 顺序即注入顺序 |
| `maxTotalChars` | 4000 | 超预算的文件**整份跳过**（不切半句） |
| `turns` | `[]` | 空 = 每轮检查去重；填 `[1]` = 只第一轮 |
| `includePreamble` | `true` | 关掉只留正文（省 token，但模型可能把记忆当新输入） |

## 设计上的取舍（说清楚，别踩）

- **注入的是消息，不是 system prompt。** DSH 插件能通过 `agent/pre-step` 往 messages 里加东西，
  但不能改 system prompt。所以记忆以一条带标记的用户消息出现——效果等价（都会进模型上下文），
  代价是它在消息列表里可见，不是隐形的系统指令。
- **零模型调用。** 读两个文件、拼字符串，没有 LLM、没有 embedding、没有网络。
  所以每次会话的成本是「那几千字符」，不是钱。
- **失败一律静默。** 目录不存在、文件读不了、编码坏了——插件跳过，不打断会话。
  记忆是锦上添花，不该有资格弄崩一次对话。
- **不自动写记忆。** 这份插件只管「注入」。谁来回填这两份文件（人工、还是另配一个后台提炼脚本），
  是你的自由——把写入和注入拆开，是为了让两边都能单独替换。

## 测试

```bash
npm test
```

8 个用例，覆盖注入、去重、空目录、目录不存在、预算守门、step 过滤、turn 白名单、拒绝分支。
全部离线，不装进 DSH 也能跑。

## 回退

```bash
dsh plugin --profile desktop remove dsh-memory-inject
```

然后重启客户端。记忆文件本身不受影响，删不删随你。

## 许可

MIT
