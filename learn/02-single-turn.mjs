import { log } from "node:console";

const tools = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "获取用户制定位置的天气信息",
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

const messages = [{ role: "user", content: "北京的天气怎么样" }];

const res1 = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
    },
    body: JSON.stringify({
        model: "qwen3.5:4b-mlx",
        messages: messages,
        tools: tools,
        stream: false,
        think: false,
        options: { num_ctx: 4096, temperature: 0 },
    }),
})

const data1 = await res1.json();
console.log(JSON.stringify(data1.message, null, 2));
console.log(data1);


const call = data1.message.tool_calls[0];

const table = {
    东京: { temp: "21", condition: "多云" },
    北京: { temp: "18", condition: "晴" },
    上海: { temp: "25", condition: "小雨" },
}

function fakeWeather(cityName) {
    return table[cityName] ?? { error: "错误名称" } 
}
const result = fakeWeather(call.function.arguments.city);
console.log(result);

messages.push(data1.message);
messages.push({ role: "tool", tool_name: "get_weather", content: JSON.stringify(result) });

const res2 = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
    },
    body: JSON.stringify({
        model: "qwen3.5:4b-mlx",
        messages: messages,
        tools: tools,
        stream: false,
        think: false,
        options: { num_ctx: 4096, temperature: 0 },
    }),
})

const data2 = await res2.json();
messages.push(data2.message);
console.log(data2.message);

