// L0：看清"工具调用"在协议层到底长什么样。
//
// 运行：node learn/01-protocol.mjs
// 这一课不要改代码，先看输出，回答下面的问题。
//
// 观察点：
//   1. message.content 是空的吗？模型"说"了什么？
//   2. message.tool_calls 里 name / arguments 分别是什么？
//   3. arguments 是 JSON 字符串，还是已经解析好的对象？
//   4. prompt_eval_count 和 eval_count 差多少？

const res = await fetch('http://localhost:11434/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen3.5:4b-mlx',
    stream: false,
    think: false,
    messages: [{ role: 'user', content: '纽约现在多少度？' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查询某个城市的实时天气',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: '城市名' },
            },
            required: ['city'],
          },
        },
      },
    ],
    options: { num_ctx: 4096, temperature: 0 },
  }),
});

const data = await res.json();
console.log(JSON.stringify(data, null, 2));