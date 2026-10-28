// 造一个"下载文件夹"式的沙箱：有明确的、有含糊的、有二进制的、有隐藏的。
// 含糊文件（无扩展名）是故意放的——它们逼 agent 真的去 read_file，而不是只看文件名瞎猜。

import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SANDBOX } from '../src/tools.js';

const reset = process.argv.includes('--reset');

if (reset) await rm(SANDBOX, { recursive: true, force: true });
await mkdir(SANDBOX, { recursive: true });

const text = {
  'invoice-2024-03.pdf': `INVOICE #2024-03
Vendor: Acme Cloud Services
Amount: 1280.00 USD
Due: 2026-11-15
`,
  'receipt-amazon.txt': `Order 112-8837261-2049
2 x USB-C Cable  ...  19.98
1 x Keyboard      ...  89.00
Total: 108.98
`,
  'notes.md': `# 项目会议记录

- 下周三前给出架构方案
- 和设计确认移动端尺寸
- 预算审批还没下来
`,
  'todo.txt': `1. 备份照片到移动硬盘
2. 研究一下本地模型跑 agent
3. 清理下载文件夹
`,
  'main.py': `def organize(files):
    for f in files:
        move(f, category_of(f))


if __name__ == "__main__":
    organize(load())
`,
  'report-q3.docx': `Q3 营收报告
环比增长 12.4%，主要来自企业客户。
`,
  'download_1': JSON.stringify(
    { type: 'api_response', user: 'lin', items: [{ id: 1 }, { id: 2 }], nested: true },
    null,
    2,
  ),
  'download_2': `随手记的一段话：

今天试了一下本地模型，9b 的推理速度勉强能用，4b 快很多。
如果只是做分类和抽取，4b 完全够了。真正难的是怎么让它别乱调工具。
`,
};

// 这些是二进制占位，read_file 应该直接拒绝
const binary = ['IMG_4821.jpg', 'screenshot-2026-10-12.png', 'track01.mp3', 'archive.zip'];

// 隐藏文件：agent 应该无视它（不要用 .DS_Store，macOS 会自己删掉）
const hidden = {
  '.env': 'API_KEY=sk-fake-not-real\nDB_URL=postgres://localhost/dev\n',
};

for (const [name, content] of Object.entries({ ...text, ...hidden })) {
  await writeFile(path.join(SANDBOX, name), content, 'utf8');
}

for (const name of binary) {
  const buf = Buffer.alloc(256);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 37) % 256;
  buf[0] = 0; // 保证含 NUL 字节
  await writeFile(path.join(SANDBOX, name), buf);
}

console.log(`沙箱已就绪：${SANDBOX}`);
console.log(`共 ${Object.keys(text).length + binary.length} 个可见文件（含 ${binary.length} 个二进制）+ 1 个隐藏文件 .env`);