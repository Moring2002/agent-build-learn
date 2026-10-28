#!/usr/bin/env node
// CLI 入口 + 可读的执行轨迹。轨迹是调 agent 时最有价值的东西：
// 模型出错时，看轨迹比看最终回答有用一百倍。

import { readdir } from 'node:fs/promises';
import { runAgent } from './agent.js';
import { SANDBOX } from './tools.js';
import { DEFAULT_MODEL } from './ollama.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const opts = { model: DEFAULT_MODEL, steps: 12, numCtx: 16384, task: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') opts.model = argv[++i];
    else if (a === '--steps') opts.steps = Number(argv[++i]);
    else if (a === '--ctx') opts.numCtx = Number(argv[++i]);
    else opts.task.push(a);
  }
  opts.task = opts.task.join(' ').trim() || '把沙箱里的文件整理归类好';
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const files = await readdir(SANDBOX).catch(() => null);
if (!files) {
  console.error(C.red(`沙箱目录不存在：${SANDBOX}\n先运行：npm run seed`));
  process.exit(1);
}
if (files.length === 0) {
  console.error(C.red('沙箱是空的。先运行：npm run seed:reset'));
  process.exit(1);
}

console.log(C.bold(`\n模型  ${opts.model}`));
console.log(C.dim(`沙箱  ${SANDBOX}`));
console.log(C.dim(`任务  ${opts.task}`));
console.log(C.dim(`上限  ${opts.steps} 步 / ${opts.numCtx} ctx\n`));

const started = Date.now();

const result = await runAgent({
  task: opts.task,
  model: opts.model,
  maxSteps: opts.steps,
  numCtx: opts.numCtx,
  onEvent(ev) {
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
  },
});

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

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}