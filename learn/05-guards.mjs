// 03-while-cycle-turn.mjs
// 演示 Agent 的「多轮工具调用循环」：
//   用户提问 → 模型决定调用哪些工具 → 本地执行工具 → 结果回填对话 → 再次询问模型 → …… → 模型给出最终文本回答
// 关键点是 while 循环：只要模型还在申请工具调用，循环就继续；模型改为输出文本时，循环结束。

// ===== 1. 工具声明（schema）=====
// 这部分只描述「有哪些工具、参数长什么样」，交给模型看，不含任何执行逻辑。
// 模型据此决定要不要调用、以及按什么参数调用。
const tools = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "获取用户指定位置的天气信息，支持城市有: 东京、北京、上海",
            // parameters 是 JSON Schema：属性名和 required 列表要和函数实现里的取值对应
            parameters: {
                type: "object",
                properties: {
                    city: {
                        type: "string",
                        description: "城市名称",
                    }
                },
                required: ["city"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_time",
            description: "获取用户指定位置的时间信息，支持城市有: 北京",
            // parameters 是 JSON Schema：属性名和 required 列表要和函数实现里的取值对应
            parameters: {
                type: "object",
                properties: {
                    city: {
                        type: "string",
                        description: "城市名称",
                    }
                },
                required: ["city"]
            }
        }
    }
];

// ===== 2. 工具的真实实现 =====
// 用一张写死的表冒充天气接口，便于专注调试「调用循环」本身而不是网络。
const table = {
    东京: { temp: 21, condition: "多云" },
    北京: { temp: 18, condition: "晴" },
    上海: { temp: 25, condition: "小雨" },
}

// 查不到城市时不抛错，而是返回 error 对象：
// 错误信息会作为工具结果一起回给模型，模型可以据此改参数重试或向用户说明情况。
function fakeWeather(cityName) {
    return table[cityName] ?? { error: `不支持的城市:${cityName}，支持的城市有: 东京、北京、上海` }
}

// 第二个工具：查时间。目前只支持北京，用于演示「多工具」时分派。
function getTime(cityName) {
    return cityName === "北京" ? { city: cityName, time: new Date().toLocaleTimeString(), timezone: "UTC+8" } : { error: `不支持的城市:${cityName}，目前仅支持查询北京` };
}

const HANDLERS = { get_weather: fakeWeather, get_time: getTime };

// 统一入口：把「模型给的工具名 + 参数」分派到具体函数，避免调用处写满 if 判断。
// 注意参数名不能叫 arguments —— .mjs 是 ES 模块，默认严格模式，arguments 是保留字。
function runTool(tool_name, tool_arguments) {
    const handler = HANDLERS[tool_name];
    // 第 1 层：工具存在吗？—— 必须在取参数之前，否则参数检查会盖住这个错误
    if (!handler) {
        const names = tools.map((tool) => tool.function.name)
        return { error: `未知工具 ${tool_name}。可用：${names.join(", ")}` };
    }

    // 第 2 层：参数形状对吗？模型可能漏传、传错类型、或者用错字段名
    const city = tool_arguments?.city;
    if (typeof city !== "string" || city.trim() === "") {
        return { error: `city 必须是非空字符串，收到的是 ${JSON.stringify(city)}` };
    }

    // 第 3 层：值在范围内吗？—— 交给工具自己判断（它才知道支持哪些城市）
    return HANDLERS[tool_name](city.trim());
}

// 把工具结果格式化成一行简短摘要，只给调试日志用，不参与回传给模型的数据。
// 按工具名分支，避免把天气字段当成所有工具的通用字段；新增工具时在这里补一个分支即可。
function formatResultSummary(tool_name, result) {
    if (result.error) {
        return result.error;
    }
    if (tool_name === "get_weather") {
        return `${result.temp}°C ${result.condition}`;
    } else if (tool_name === "get_time") {
        return `${result.time} ${result.timezone}`;
    } else {
        return JSON.stringify(result);
    }
}

// ===== 3. 模型请求封装 =====
// 把「怎么问模型」从调用循环里抽出来：循环只关心「拿到回答后干什么」，
// 请求地址、模型名、采样参数这些配置改动时只需动这一处。
// 参数用调用处同名变量直接传入（messages / tools 在下方定义），不再重复声明常量。
async function askModel(messages, tools) {
    const res = await fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "qwen3.5:4b-mlx",
            messages: messages,
            tools: tools,
            stream: false,   // 关掉流式，直接拿完整响应，便于观察 tool_calls 结构
            think: false,    // 关掉思考输出，避免混入推理内容干扰调试
            options: { num_ctx: 4096, temperature: 0 },  // temperature 0：让同样的输入尽量得到同样的调用决策
        }),
    })

    // HTTP 层先判错：模型没启动/请求体格式不对时，不必再去解析 JSON
    if (!res.ok) {
        console.error("Error:", res.status, res.statusText);
        process.exit(1);
    }

    // 直接返回解析好的响应体，调用处拿到的就是 { message: ... } 结构，不用再关心 res/data 两层
    const data = await res.json();
    return data;
}

// ===== 4. 对话历史 =====
// messages 是唯一的「状态」：每轮都把新消息追加进来，所以模型能看到之前的工具结果。
// 只放一条 user 消息，剩下的都由循环动态累积。
const messages = [{ role: "user", content: "北京天气怎么样？" }];

// step：已进行的轮数；answer：最终文本答案；finished：是否正常结束（区别于撞上轮数上限）。
let step = 0;
let answer = "";
let stopped = null;
let maxSteps = 10;

const seen = new Map();

// 上限 10 轮是硬性保险：防止模型反复申请工具导致死循环。
while (step < maxSteps) {
    // ---- 3.1 请求模型：带上完整历史 + 全部工具声明 ----
    const data = await askModel(messages, tools);

    // ---- 3.2 判断模型是「要调工具」还是「已给出答案」 ----
    // 模型没有调用工具时，Ollama 不返回 tool_calls 字段（值是 undefined），所以必须先判空。
    const tool_calls = data.message.tool_calls;
    console.log('tool_calls:', tool_calls);
    // 逐个打印参数：console.log 默认只展开一层对象，arguments 会显示成 [Object]，
    // 用 JSON.stringify 才能看到实际字段，用来确认参数路径是 message.tool_calls[].function.arguments。
    if (tool_calls && tool_calls.length > 0) {
        for (const call of tool_calls) {
            console.log('arguments:', JSON.stringify(call.function.arguments));
        }
    }

    // 没有工具调用 = 模型认为信息已足够，本轮 content 就是最终答案，退出循环。
    if (!tool_calls || tool_calls.length === 0) {
        answer = data.message.content;
        stopped = "finished";
        break;
    }

    // ---- 3.3 执行工具，并把结果回填进对话 ----
    // 先把模型这条「我要调用工具」的 assistant 消息原样存入历史；
    // 这一步不能省：工具结果必须紧跟在发起调用的那条 assistant 消息之后，否则对话结构不合法。
    messages.push(data.message);

    // 一次循环同时完成「执行」和「回填」，保证每个工具只被执行一遍。
    // results 与 tool_calls 顺序一一对应，仅用于后面打印。
    const results = [];
    const nudges = [];
    for (const call of tool_calls) {

        const tool_name = call.function.name;
        const args = call.function.arguments ?? {};
        const key = `${tool_name}:${JSON.stringify(args)}`;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);

        if (count > 3) {
            stopped = "repeated";
            break;
        }

        if (count === 2) {
            nudges.push(`你尝试用${tool_name}这个完全相同的参数${count}次了，请换一个参数再试`);
        }


        const result = runTool(call.function.name, call.function.arguments);
        results.push(result);
        messages.push({
            role: "tool",
            tool_name: call.function.name,   // 标明这条结果来自哪个工具（多工具并行调用时需要）
            content: JSON.stringify(result)   // content 必须是字符串，所以把结果序列化
        })
    }

    console.log('results:', results);

    // ---- 3.4 打印本轮概览，然后进入下一轮 ----
    // results 与 tool_calls 下标一一对应，所以按下标取值：这样能同时拿到工具名和结果。
    // 成功与失败都带工具名/城市前缀，多个调用挤在一行时才能分得清哪条对应哪个。
    const summaries = tool_calls.map((call, index) => {
        const summary = formatResultSummary(call.function.name, results[index]);
        if (results[index].error) {
            return `${call.function.name}(${call.function.arguments.city}) 失败: ${summary}`;
        } else {
            return `${call.function.name}(${call.function.arguments.city}) ${summary}`;
        }
    });
    console.log(`[第 ${step + 1} 轮] ${summaries.join(' | ')}`);

    if (stopped === "repeated") break;

    for (const n of nudges) {
        messages.push({ role: "user", content: n });
    }

    step++;
    if (stopped === null) stopped = "max_steps";
}

// ===== 5. 出口 =====
let finalAnswer = answer;
if (stopped !== "finished") {
    messages.push({ role: "user", content: `停止原因：${stopped}，基于messages尽力回答，信息不足的地方说明缺了什么` });
    const last = await askModel(messages, null);
    finalAnswer = last.message.content;
}

console.log(finalAnswer);
if (stopped !== "finished") process.exit(1);
