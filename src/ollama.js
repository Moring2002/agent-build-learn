// Ollama 的最薄客户端。只做一件事：一次 /api/chat 调用。
// 关键参数都在这里显式写死，不要依赖模型默认值。

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

export const DEFAULT_MODEL = process.env.AGENT_MODEL ?? 'qwen3.5:4b-mlx';

export async function chat({
  model = DEFAULT_MODEL,
  messages,
  tools,
  numCtx = 16384,
  temperature = 0,
  timeoutMs = 180_000,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        // 关掉思维链：agent 循环里省时间，也避免推理内容污染上下文
        think: false,
        options: {
          num_ctx: numCtx, // 默认值太小，多轮工具调用会被截断
          temperature,
          top_p: 0.9,
          repeat_penalty: 1.05,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 400)}`);
    }

    const data = await res.json();
    return {
      message: data.message ?? {},
      stats: {
        wallMs: Date.now() - started,
        promptTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        tokPerSec: data.eval_duration
          ? Number((data.eval_count / (data.eval_duration / 1e9)).toFixed(1))
          : null,
        loadMs: data.load_duration ? Math.round(data.load_duration / 1e6) : 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}