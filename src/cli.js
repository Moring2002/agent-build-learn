#!/usr/bin/env node
// CLI 入口，两种模式：
//   node src/cli.js "任务…"   跑一次就退出（脚本/演示用）
//   node src/cli.js           交互 REPL：输入任务回车运行，
//                             /messages 查看完整对话（每个 role 说了什么）
// 轨迹和完整对话是调试 agent 最有价值的东西：模型出错时，看它们比看最终回答有用一百倍。

import readline from 'node:readline/promises';
import { readdir } from 'node:fs/promises';
import { runAgent } from './agent.js';
import { SANDBOX, TOOL_SPECS, checkState } from './tools.js';
import { DEFAULT_MODEL } from './ollama.js';

// ---- 本 CLI 装配的 agent：引擎在 agent.js，这里决定"它是谁" ----
// 换任务 = 换下面的 systemPrompt / tools / onFinish，引擎一行不用动；
// 想共存多种能力（文件 + 天气……），把新工具注册进 tools.js 的 TOOLS，再改这段提示词。

const SYSTEM_PROMPT = `你是一个文件整理 agent，在沙箱目录内工作。

规则：
1. 所有路径都是相对沙箱根目录的写法，根目录用 "."。
2. 先 list_files 看清有什么，再动手。
3. 无扩展名或含义不明的文件，必须先用 read_file 看内容再决定放哪。
4. 用 move_file 移动到分类子目录，路径写成 "分类/文件名"（目录会自动创建）。
5. 不要移动已经归好类的文件。隐藏文件（以 . 开头，尤其是 .env）必须留在根目录，绝对不要移动或改名。
6. 全部完成后调用 finish，summary 里逐个列出每个分类下有哪些文件。
7. 目标：根目录最后只剩分类子目录，所有非隐藏文件都要移走。不要只在 summary 里描述，必须真的移动。

直接调用工具，不要输出解释性长文。`;

/** finish 的事实校验：返回问题列表，空数组 = 真的完工了。agent.js 只认这个形状，不关心内容。 */
async function checkFinish() {
  const { unclassified, protectedMissing } = await checkState();
  const problems = [];
  if (unclassified.length > 0) {
    problems.push(
      `根目录还有 ${unclassified.length} 个非隐藏文件没归类（${unclassified.join('、')}）。请继续处理，把根目录清空后再调用 finish。`,
    );
  }
  if (protectedMissing.length > 0) {
    problems.push(
      `受保护的隐藏文件被移动或删除了：${protectedMissing.join('、')}。必须把它移回根目录，隐藏文件不允许移动。`,
    );
  }
  return problems;
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const MSG_CAP = 500; // /messages 里单条 tool 结果的展示上限，超出截断并标注总长度

function parseArgs(argv) {
  const opts = { model: DEFAULT_MODEL, steps: 12, numCtx: 16384, task: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--steps') opts.steps = Number(argv[++i]);
    else if (a === '--ctx') opts.numCtx = Number(argv[++i]);
    else opts.task.push(a);
  }
  opts.task = opts.task.join(' ').trim() || null; // 无任务参数 → 交互模式
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const sandboxState = await readdir(SANDBOX).then(
  (files) => ({ exists: true, empty: files.length === 0 }),
  () => ({ exists: false, empty: false }),
);
if (!sandboxState.exists) {
  console.error(C.red(`沙箱目录不存在：${SANDBOX}\n先运行：npm run seed`));
  process.exit(1);
}
if (sandboxState.empty) {
  console.error(C.yellow('提示：沙箱是空的，agent 没什么可整理的。可先运行：npm run seed:reset'));
}

// ---- 运行一次任务（两种模式共用）----

let lastMessages = null;

async function runTask(task) {
  const started = Date.now();
  const result = await runAgent({
    task,
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOL_SPECS,
    onFinish: checkFinish,
    model: opts.model,
    maxSteps: opts.steps,
    numCtx: opts.numCtx,
    onEvent: printEvent,
  });
  lastMessages = result.messages;
  printResult(result, started);
}

function printEvent(ev) {
  if (ev.type === 'model') {
    const { stats } = ev;
    const meta = [
      `${stats.wallMs}ms`,
      stats.tokPerSec ? `${stats.tokPerSec} tok/s` : null,
      stats.loadMs ? `加载 ${stats.loadMs}ms` : null,
      `ctx ${stats.promptTokens}→${stats.outputTokens}`,
    ]
      .filter(Boolean)
      .join('  ');
    console.log(C.dim(`[第 ${ev.step} 步] ${meta}`));
    if (ev.content) console.log(C.dim(`  想法  ${truncate(ev.content, 200)}`));
  }

  if (ev.type === 'tool') {
    const { call, outcome } = ev;
    console.log(
      `  ${C.cyan('→')} ${C.bold(call.name)} ${C.dim(JSON.stringify(call.args))}`,
    );
    if (outcome.ok) {
      console.log(`     ${C.green('←')} ${C.dim(truncate(JSON.stringify(outcome.result), 240))}`);
    } else {
      console.log(`     ${C.red('← 错误')} ${truncate(outcome.error, 240)}`);
    }
  }

  if (ev.type === 'reject') {
    console.log(`  ${C.yellow('! 完成校验未通过')} ${C.dim(ev.error)}`);
  }

  if (ev.type === 'nudge') {
    console.log(`  ${C.yellow('! 检测到重复调用，已提醒模型换做法')}`);
  }
}

function printResult(result, started) {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  if (result.finished) {
    console.log(C.green('✔ 完成'));
    console.log(result.answer);
  } else if (result.reason === 'max_steps') {
    console.log(C.red('✘ 达到步数上限，任务未完成'));
  } else {
    console.log(C.yellow('△ 模型没调用 finish 就结束了'));
    console.log(result.answer);
  }

  console.log(
    C.dim(`\n${result.steps} 步  用时 ${elapsed}s  生成 ${result.totalOutput} tokens`),
  );
}

// ---- /messages：把发给模型的 messages 数组整个摊开 ----
// 学 agent 最重要的一件事：agent 的全部状态就是这个数组，每轮原样重放给模型。

function printMessages(messages) {
  if (!messages || messages.length === 0) {
    console.log(C.dim('还没有对话。先输入一个任务运行。'));
    return;
  }

  console.log(C.bold(`\n完整对话（${messages.length} 条，每轮发给模型的就是这个数组）`));
  messages.forEach((m, i) => {
    const n = C.dim(`${String(i + 1).padStart(3)}  `);
    if (m.role === 'system') {
      console.log(`${n}${C.dim('[system]')} ${C.dim(m.content)}`);
    } else if (m.role === 'user') {
      console.log(`${n}${C.bold('[user]')} ${m.content}`);
    } else if (m.role === 'assistant') {
      console.log(`${n}${C.cyan('[assistant]')}`);
      if ((m.content ?? '').trim()) console.log(`       想法  ${m.content.trim()}`);
      for (const tc of m.tool_calls ?? []) {
        console.log(
          `       ${C.cyan('→')} ${tc.function.name} ${C.dim(JSON.stringify(tc.function.arguments))}`,
        );
      }
    } else if (m.role === 'tool') {
      const body = m.content ?? '';
      const shown =
        body.length > MSG_CAP
          ? `${body.slice(0, MSG_CAP)}…（共 ${body.length} 字，已截断）`
          : body;
      console.log(`${n}${C.yellow('[tool]')} ${C.dim(`(${m.tool_name})`)}`);
      console.log(C.dim(`       ${shown}`));
    }
  });
  console.log('');
}

// ---- /sandbox：看 agent 跑完之后，文件系统变成了什么样 ----

async function printSandbox() {
  const dirents = await readdir(SANDBOX, { withFileTypes: true }).catch(() => []);
  if (dirents.length === 0) {
    console.log(C.dim('（沙箱是空的）'));
    return;
  }
  console.log(C.bold(`\n沙箱  ${SANDBOX}`));
  for (const d of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.isDirectory()) console.log(`  ${C.cyan(`${d.name}/`)}`);
    else if (d.name.startsWith('.')) console.log(C.dim(`  ${d.name}`));
    else console.log(`  ${d.name}`);
  }
}

function printHelp() {
  console.log(C.bold('\n可用命令'));
  console.log(`  ${C.cyan('/messages')}   查看上一次运行的完整对话（每个 role 说了什么）`);
  console.log(`  ${C.cyan('/sandbox')}    查看沙箱当前文件`);
  console.log(`  ${C.cyan('/help')}       显示本帮助`);
  console.log(`  ${C.cyan('/quit')}       退出（Ctrl+C 同效）`);
  console.log(C.dim('其他输入 = 任务，回车运行。以 / 开头会被当作命令。'));
}

// ---- 交互 REPL ----

async function repl() {
  console.log(C.bold(`\n模型  ${opts.model}`));
  console.log(C.dim(`沙箱  ${SANDBOX}`));
  console.log(C.dim(`上限  ${opts.steps} 步 / ${opts.numCtx} ctx`));
  console.log(C.dim('输入任务回车即运行；/help 查看命令，/quit 退出'));
  if (!process.stdin.isTTY) console.log(C.yellow('提示：检测不到交互终端，REPL 需要真实 TTY'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => rl.close()); // Ctrl+C：退出前恢复终端
  rl.on('close', () => {
    console.log('');
    process.exit(0);
  });

  while (true) {
    let line;
    try {
      line = (await rl.question(C.bold('\ntask › '))).trim();
    } catch {
      break; // Ctrl+D 等导致流关闭，交给 close 事件退出
    }
    if (!line) continue;

    if (line.startsWith('/')) {
      const cmd = line.split(/\s+/, 1)[0].toLowerCase();
      if (cmd === '/quit' || cmd === '/q' || cmd === '/exit') {
        rl.close();
        return;
      }
      if (cmd === '/help' || cmd === '/h') printHelp();
      else if (cmd === '/messages' || cmd === '/m') printMessages(lastMessages);
      else if (cmd === '/sandbox' || cmd === '/ls') await printSandbox();
      else console.log(C.yellow(`不认识命令 ${cmd}，/help 查看全部`));
      continue;
    }

    await runTask(line);
    console.log(C.dim('（/messages 查看这次运行的完整对话）'));
  }
}

// ---- 入口 ----

if (opts.task) {
  console.log(C.bold(`\n模型  ${opts.model}`));
  console.log(C.dim(`沙箱  ${SANDBOX}`));
  console.log(C.dim(`任务  ${opts.task}`));
  console.log(C.dim(`上限  ${opts.steps} 步 / ${opts.numCtx} ctx\n`));
  await runTask(opts.task);
  console.log(C.dim('（提示：不带参数运行 npm start 可进入交互模式，/messages 查看完整对话）'));
} else {
  await repl();
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
