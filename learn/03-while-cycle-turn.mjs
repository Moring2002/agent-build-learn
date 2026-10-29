const tools = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description: "获取用户指定位置的天气信息",
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

const table = {
    东京: { temp: 21, condition: "多云" },
    北京: { temp: 18, condition: "晴" },
    上海: { temp: 25, condition: "小雨" },
}

function fakeWeather(cityName) {
    return table[cityName] ?? { error: "支持的城市有: 东京、北京、上海" }
}

function getTime(cityName) {
    return cityName === "北京" ? { city: cityName, time: new Date().toLocaleTimeString(), timezone: "UTC+8" } : { error: "目前仅支持查询北京" };
}

function runTool(tool_name, arguments) {
    
}
const messages = [{ role: "user", content: "哪里在下雨" }];

let step = 0;
let answer = "";
let finished = false;

while (step < 10) {
    const res = await fetch("http://localhost:11434/api/chat", {
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

    if (!res.ok) {
        console.error("Error:", res.status, res.statusText);
        process.exit(1);
    }

    const data = await res.json();

    const tool_calls = data.message.tool_calls;
    console.log('tool_calls:', tool_calls);
    if (tool_calls && tool_calls.length > 0) {
        for (const call of tool_calls) {
            console.log('arguments:', JSON.stringify(call.function.arguments));
        }
    }

    if (!tool_calls || tool_calls.length === 0) {
        answer = data.message.content;
        finished = true;
        break;
    }
    const results = tool_calls.map((call) => {
        tool_name: fakeWeather(call.function.arguments.city)
        resule: 
    })
    console.log('results:', results);

    messages.push(data.message);
    for (const result of results) {
        messages.push({
            role: "tool",
            tool_name: "get_weather",
            content: JSON.stringify(result)
        })
    }

    console.log(`[第 ${step + 1} 轮] 申请 ${tool_calls.length} 个: ${tool_calls.map(c => c.function.arguments.city).join('、')}`);
    console.log(`[第 ${step + 1} 轮] 返回: ${results.map(r => r.error ? r.error : `${r.temp}°C ${r.condition}`).join(', ')}`);

    step++;
}

if (finished) {
    console.log("最终答案:", answer);
} else {
    console.log("未完成");
}

