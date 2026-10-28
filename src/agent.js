// Agent 核心循环。整个"智能"就藏在这几十行里：
//   发给模型 → 它要调工具 → 我们执行并把结果塞回对话 → 再发给模型 → 直到它调 finish
//
// 小模型上真正决定成败的是三个护栏，不是提示词写得多漂亮：
//   1. 参数校验：模型给的参数永远当不可信输入
//   2. 重复检测：它会在同一个错误上打转，必须主动打断
//   3. 步数上限：防止无限循环烧时间

import { chat, DEFAULT_MODEL } from './ollama.js';
import { TOOL_SPECS, callTool, TOOL_NAMES, checkState } from './tools.js';

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

const brief = (value, max = 160) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export async function runAgent({
  task,
  model = DEFAULT_MODEL,
  maxSteps = MAX_STEPS,
  numCtx = 16384,
  onEvent = () => {},
}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];

  const trace = [];
  const seen = new Map();
  let totalOutput = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const { message, stats } = await chat({ model, messages, tools: TOOL_SPECS, numCtx });
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
      // --- finish：正常出口，但必须先通过事实校验 ---
      if (call.name === 'finish') {
        const { unclassified, protectedMissing } = await checkState();
        const problems = [];
        if (unclassified.length > 0) {
          problems.push(
            `根目录还有 ${unclassified.length} 个非隐藏文件没归类（${unclassified.join('、')}）。请继续处理，把根目录清空后再调用 finish。`,
          );
        }
        if (protectedMissing.length > 0) {
          problems.push(
            `受保护的隐藏文件被移动或删除了：${protectedMissing.join(
              '、',
            )}。必须把它移回根目录，隐藏文件不允许移动。`,
          );
        }

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
  };
}

function shortResult(result) {
  if (result && Array.isArray(result.entries)) {
    return { count: result.count, paths: result.entries.map((e) => e.path) };
  }
  return result;
}

export { TOOL_NAMES, brief };