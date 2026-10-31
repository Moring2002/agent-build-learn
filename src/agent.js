// Agent 核心引擎。整个"智能"就藏在这几十行里：
//   发给模型 → 它要调工具 → 我们执行并把结果塞回对话 → 再发给模型 → 直到它调 finish
//
// 本文件是通用引擎，不认识任何具体任务：任务规则(systemPrompt)、发给模型的工具清单(tools)、
// 完工校验(onFinish)都由调用方注入——换一套注入就是另一个 agent（组装在 cli.js）。
// 注意：工具的真正执行仍走 tools.js 的 callTool 分发，所以"能执行哪些工具"注册在 tools.js，
// tools 参数只决定"把哪些工具广告给模型"。两个清单目前一致，工具变多再考虑拆注册表。
//
// 小模型上真正决定成败的是护栏，不是提示词写得多漂亮：
//   1. 参数校验：模型给的参数永远当不可信输入（tools.js 的 callTool）
//   2. 重复检测：它会在同一个错误上打转，必须主动打断
//   3. 步数上限：防止无限循环烧时间
//   4. finish 必须过 onFinish 的事实校验才算数（由调用方注入）

import { chat, DEFAULT_MODEL } from './ollama.js';
import { callTool } from './tools.js';

const MAX_STEPS = 12;
const REPEAT_LIMIT = 2;

/** 把模型返回的 tool_calls 规整成 { name, args, parseError }。 */
function normalizeCalls(raw = []) {
  return raw.map((call, i) => {
    const fn = call.function ?? call;
    let args = fn.arguments ?? {};

    // Ollama 通常直接给对象，但个别模型会返回 JSON 字符串
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch (err) {
        return { name: fn.name ?? '', args: {}, parseError: err.message };
      }
    }
    return { name: fn.name ?? '', args };
  });
}

export async function runAgent({
  task,
  systemPrompt,
  tools,
  onFinish = null,
  model = DEFAULT_MODEL,
  maxSteps = MAX_STEPS,
  numCtx = 16384,
  onEvent = () => {},
}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  const trace = [];
  const seen = new Map();
  let totalOutput = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const { message, stats } = await chat({ model, messages, tools, numCtx });
    totalOutput += stats.outputTokens;

    const content = (message.content ?? '').trim();
    const calls = normalizeCalls(message.tool_calls ?? []);

    onEvent({ type: 'model', step, content, calls, stats });

    // 没有工具调用 = 模型认为可以收尾了，但我们的协议要求它调 finish
    if (calls.length === 0) {
      trace.push({ step, content, calls: [] });
      return {
        ok: true,
        finished: false,
        answer: content,
        steps: step,
        trace,
        totalOutput,
        messages,
        note: '模型没有调用任何工具就结束了（未调用 finish）',
      };
    }

    // 把 assistant 这轮原样放回历史，否则模型会忘记自己请求过什么
    messages.push({
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: calls.map((c, i) => ({
        id: `call_${step}_${i}`,
        function: { name: c.name, arguments: c.args },
      })),
    });

    for (const call of calls) {
      // --- finish：正常出口，但必须先通过调用方注入的事实校验 ---
      if (call.name === 'finish') {
        const problems = onFinish ? await onFinish(call.args) : [];

        if (problems.length > 0) {
          const error = `finish 被拒绝：${problems.join(' ')}`;
          messages.push({
            role: 'tool',
            tool_name: 'finish',
            content: JSON.stringify({ error }),
          });
          onEvent({ type: 'reject', step, error });
          trace.push({ step, calls: [call], outcome: { rejected: problems } });
          continue;
        }

        trace.push({ step, calls: [call] });
        const summary = call.args?.summary ?? '';
        return {
          ok: true,
          finished: true,
          answer: summary,
          steps: step,
          trace,
          totalOutput,
          messages,
        };
      }

      // --- 重复检测：同一个工具 + 同一组参数连续出现，就是在死循环 ---
      const key = `${call.name}:${JSON.stringify(call.args)}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);

      let outcome;
      if (call.parseError) {
        outcome = { ok: false, error: `参数不是合法 JSON：${call.parseError}` };
      } else {
        outcome = await callTool(call.name, call.args);
      }

      const payload = outcome.ok ? outcome.result : { error: outcome.error };
      messages.push({
        role: 'tool',
        tool_name: call.name,
        content: JSON.stringify(payload),
      });

      onEvent({ type: 'tool', step, call, outcome });

      trace.push({
        step,
        calls: [call],
        outcome: outcome.ok ? shortResult(outcome.result) : { error: outcome.error },
      });

      if (count >= REPEAT_LIMIT) {
        seen.set(key, 0);
        messages.push({
          role: 'user',
          content: `你已经用完全相同的参数调用 ${call.name} ${count} 次了。请根据上面的返回结果换一种做法；如果确实没别的事可做，就调用 finish。`,
        });
        onEvent({ type: 'nudge', step, tool: call.name });
      }
    }
  }

  return {
    ok: false,
    finished: false,
    reason: 'max_steps',
    answer: '',
    steps: maxSteps,
    trace,
    totalOutput,
    messages,
  };
}

function shortResult(result) {
  if (result && Array.isArray(result.entries)) {
    return { count: result.count, paths: result.entries.map((e) => e.path) };
  }
  return result;
}