# agent-studio

用本地 Ollama 模型跑一个**窄域工具 agent**。零依赖（Node 原生 `fetch`），几百行代码，把 agent 的机制完整摊开：规划 → 调工具 → 校验 → 纠错 → 收尾。

配套模型：`qwen3.5:4b-mlx`（默认）/ `qwen3.5:9b-mlx`。演示任务是"把下载文件夹整理归类"。

## 快速开始

```bash
ollama serve                  # 确保在跑
npm run demo                  # 重建沙箱 + 跑 agent（跑一次就退出）
```

交互模式（推荐学习用）：不带任务参数启动就进入 REPL，输入任务回车运行，跑完还能翻看完整对话。

```bash
npm start                     # 进入交互模式
task › 把沙箱里的文件整理归类好
task › /messages              # 查看上一次运行的完整对话（system/user/assistant/tool 逐条列出）
task › /sandbox               # 查看沙箱当前文件
task › /help                  # 全部命令
task › /quit                  # 退出（Ctrl+C 同效）
```

每个任务都是独立的一次运行（新的 messages 数组）。`/messages` 展示的就是每轮发给模型的那个数组——看 agent 在干嘛，先看它。

换模型、调步数：

```bash
npm run seed:reset
npm start -- --model qwen3.5:9b-mlx --steps 15        # 带这些配置进入交互模式
npm start -- --model qwen3.5:9b-mlx --steps 15 "把沙箱里的文件整理归类好"  # 跑一次就退出
```

自定义任务：

```bash
npm run seed:reset
npm start -- "把 PDF 和收据移到 finance/，代码移到 code/，其余你自己判断"
```

## 目录结构

```
src/
  ollama.js    /api/chat 的最薄封装（num_ctx、think:false、temperature）
  tools.js     工具定义 + schema 校验 + 沙箱守卫 + checkState 完成校验
  agent.js     agent 引擎（通用）：循环 + 护栏；任务规则/工具/完工校验由调用方注入
  cli.js       CLI 入口：REPL + /messages 查看；在这里组装 agent（prompt、tools、onFinish）
scripts/
  seed.js      造演示沙箱（含无扩展名、二进制、隐藏文件）
sandbox/       所有文件操作的唯一作用域
```

## 核心循环

`src/agent.js` 的 `runAgent()` 就是全部：

```
messages = [system, user]
loop:
  → 把 messages + tools 发给模型
  → 模型返回 tool_calls（可能一次多个）
  → 逐个执行，结果以 role:"tool" 塞回 messages
  → 若调用 finish 且通过校验 → 结束
  → 否则继续
```

`runAgent` 是通用引擎：`systemPrompt`（任务规则）、`tools`（广告给模型的工具清单）、`onFinish`（完工事实校验）都由调用方注入，组装见 `cli.js` 顶部。换一套注入就是另一个 agent。

没有魔法。框架（LangGraph、Pydantic AI、smolagents）做的事本质也是这个循环，外加状态管理和可观测性。

## 三个护栏（比提示词重要）

小模型不是"能力不够"，是"不可靠"。让它能用的关键是把不可靠挡在循环外面：

**1. 参数永远当不可信输入** — `tools.js` 里手写了 schema 校验（必填、类型、枚举、多余字段）。校验失败不抛异常，而是把 `{ error }` 作为工具结果返回，模型下一轮自己改。实测模型确实会改对。

**2. 重复调用检测** — 同一个工具 + 同一组参数连续出现 2 次，就注入一条提醒打断它。小模型在报错后会原地打转，不打断会烧完整个步数预算。

**3. 完成校验（最重要）** — `finish` 不是模型说了算。`checkState()` 检查两个不变量：

- 根目录不能残留非隐藏文件
- `.env` 这类受保护文件必须原地不动

第一次跑的时候模型声称"已完成整理"，实际只移了 3 个文件、还剩 9 个；另一次它把 `.env` 挪进了 `config/`。两次都被校验拦下并纠正了。**凡是"做完了"这种断言，都要用外部事实验证。**

## 实测（M4 / 16GB）

| 模型 | 步数 | 耗时 | 速度 | 观察 |
|---|---|---|---|---|
| qwen3.5:4b-mlx | 4–8 | 18–42s | ~27 tok/s | 全程可用；分类偏粗（`data/` 混装 zip）。失败模式稳定：提前宣布完工 |
| qwen3.5:9b-mlx | 6 | 82s | ~15 tok/s | 分类明显更好（文档/媒体/数据分开，还顺手把 `download_2` 改成 `.md`）。但**同样谎报完成**，同样被校验拦下 |

关键结论：9b 改善的是"分类质量"，**不改善"可靠性"**。谎报完成、改隐藏文件这类问题换更大的模型也不会消失——它们是架构问题，只能靠校验挡住。所以 4b + 严格的护栏，通常比 9b + 宽松的护栏更好用。

## 加一个工具

在 `src/tools.js` 的 `TOOLS` 数组里加一项，`schema` 写死、`run` 里对错误抛 `ToolError`：

```js
{
  name: 'rename_file',
  description: '给沙箱内文件改名，不改目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对沙箱根目录的文件路径' },
      name: { type: 'string', description: '新文件名，不含路径分隔符' },
    },
    required: ['path', 'name'],
    additionalProperties: false,
  },
  async run({ path: rel, name }) {
    const abs = safePath(rel);           // 自动挡住路径逃逸
    if (name.includes('/')) throw new ToolError('name 不能包含 /');
    ...
  },
}
```

`TOOL_SPECS` 会自动同步给模型。要注意：**工具越多，小模型选错工具的概率越高**。超过 6–8 个就该考虑拆成两个 agent，或者用路由先分类。

## 已知局限

- **上下文**：`num_ctx` 写死 16384。文件多了历史会爆，需要加摘要或裁剪（`agent.js` 里 messages 数组就是裁剪点）。
- **不并行**：16GB 内存上同时跑两个模型会换页，工具调用是串行的。
- **无记忆**：每次运行从头开始。要跨任务记忆得自己接向量库。
- **无审批**：`move_file` 直接执行。接真实目录之前，应该加一个 `--dry-run` 或者人工确认钩子——这是下一步最该做的事。

## 下一步

1. `--dry-run`：只打印计划不执行，确认后再跑
2. 换任务：把 `move_file` 换成 HTTP / SQLite 工具，同一套循环能用
3. 9b 当审核员：4b 干活，9b 在 `finish` 前复核 summary 是否与实际一致
4. 接 MCP：把 `tools.js` 暴露成 MCP server，让 Claude Code 也能调用本地模型和这套沙箱