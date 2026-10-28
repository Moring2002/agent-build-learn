// 工具层：schema 定义 + 参数校验 + 沙箱路径守卫 + 真实执行。
//
// 三条原则（小模型上尤其重要）：
//   1. 参数 schema 写死，能用枚举就不要用自由字符串
//   2. 任何失败都以 { error } 的形式返回给模型，让它自己纠错，不要抛异常炸掉循环
//   3. 所有文件操作锁死在 SANDBOX 内，路径逃逸直接拒绝

import { readdir, readFile, rename, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const SANDBOX = path.resolve(process.env.AGENT_SANDBOX ?? 'sandbox');

const MAX_ENTRIES = 300;
const MAX_READ_CHARS = 1500;

class ToolError extends Error {}

const TOOLS = [
  {
    name: 'list_files',
    description:
      '列出沙箱目录下的文件。返回每个文件的相对路径、字节大小、扩展名。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '相对沙箱根目录的目录路径，根目录写 "."',
        },
        recursive: {
          type: 'boolean',
          description: '是否递归子目录，默认 false',
        },
      },
      required: ['dir'],
      additionalProperties: false,
    },
    async run({ dir, recursive = false }) {
      const abs = safePath(dir);
      const entries = [];
      await walk(abs, dir === '.' ? '' : dir, Boolean(recursive), entries, 0);
      return {
        dir,
        count: entries.length,
        truncated: entries.length >= MAX_ENTRIES,
        entries,
      };
    },
  },

  {
    name: 'read_file',
    description:
      '读取沙箱内一个文本文件的前若干字符。用于判断无扩展名或含义不明的文件。遇到二进制文件会报错。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对沙箱根目录的文件路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run({ path: rel }) {
      const abs = safePath(rel);
      const info = await stat(abs).catch(() => null);
      if (!info) throw new ToolError(`文件不存在：${rel}`);
      if (!info.isFile()) throw new ToolError(`不是文件：${rel}`);

      const buf = await readFile(abs);
      if (buf.includes(0)) throw new ToolError(`${rel} 是二进制文件，无法按文本读取`);

      const text = buf.toString('utf8');
      return {
        path: rel,
        bytes: info.size,
        truncated: text.length > MAX_READ_CHARS,
        content: text.slice(0, MAX_READ_CHARS),
      };
    },
  },

  {
    name: 'move_file',
    description:
      '把沙箱内一个文件移动到新路径。目标父目录不存在会自动创建。目标已存在会报错。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件相对路径' },
        to: {
          type: 'string',
          description: '目标相对路径，例如 "docs/report.docx"',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async run({ from, to }) {
      const src = safePath(from);
      const dst = safePath(to);
      if (src === SANDBOX || dst === SANDBOX) throw new ToolError('不能移动目录本身');
      if (src === dst) throw new ToolError('源和目标是同一个文件');

      const info = await stat(src).catch(() => null);
      if (!info) throw new ToolError(`源文件不存在：${from}`);
      if (!info.isFile()) throw new ToolError(`不是文件：${from}`);

      const exists = await stat(dst).catch(() => null);
      if (exists) throw new ToolError(`目标已存在，不能覆盖：${to}`);

      await mkdir(path.dirname(dst), { recursive: true });
      await rename(src, dst);
      return { moved: from, to };
    },
  },

  {
    name: 'finish',
    description:
      '全部整理完成后调用。summary 里写清楚每个分类目录下有哪些文件。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '本次整理结果的简要总结' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    async run({ summary }) {
      return { summary };
    },
  },
];

export const TOOL_SPECS = TOOLS.map(({ name, description, parameters }) => ({
  type: 'function',
  function: { name, description, parameters },
}));

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const TOOL_NAMES = new Set(BY_NAME.keys());

/**
 * 完成校验：拿外部事实去验证 agent 的说法，而不是听它自己宣布完工。
 * 小模型最常见的失败就是"谎报完成"，甚至顺手把不该动的文件也移走。
 *
 * 两个不变量：
 *   1. 根目录不能残留非隐藏文件
 *   2. 受保护的隐藏文件（如 .env）必须原地不动
 */
const PROTECTED = ['.env'];

export async function checkState() {
  const dirents = await readdir(SANDBOX, { withFileTypes: true }).catch(() => []);
  const rootFiles = dirents.filter((d) => d.isFile()).map((d) => d.name);

  return {
    unclassified: rootFiles.filter((n) => !n.startsWith('.')).sort(),
    protectedMissing: PROTECTED.filter((n) => !rootFiles.includes(n)),
  };
}

/** 执行一次工具调用，永远返回 { ok, result } | { ok:false, error }。 */
export async function callTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    return { ok: false, error: `未知工具 "${name}"。可用工具：${[...TOOL_NAMES].join(', ')}` };
  }

  const errors = validate(tool.parameters, args);
  if (errors.length) {
    return { ok: false, error: `参数不合法：${errors.join('; ')}` };
  }

  try {
    return { ok: true, result: await tool.run(args) };
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, error: err.message };
    return { ok: false, error: `执行失败：${err.message}` };
  }
}

// ---- 内部实现 ----

function safePath(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new ToolError('路径不能为空');
  }
  const abs = path.resolve(SANDBOX, rel);
  const root = SANDBOX.endsWith(path.sep) ? SANDBOX : SANDBOX + path.sep;
  if (abs !== SANDBOX && !abs.startsWith(root)) {
    throw new ToolError(`路径越界，只能操作沙箱内的文件：${rel}`);
  }
  return abs;
}

async function walk(absDir, relDir, recursive, out, depth) {
  if (out.length >= MAX_ENTRIES) return;

  let dirents;
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch {
    throw new ToolError(`目录不存在或不可读：${relDir || '.'}`);
  }

  for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_ENTRIES) return;
    const rel = relDir ? `${relDir}/${d.name}` : d.name;

    if (d.isDirectory()) {
      if (recursive && depth < 4) await walk(path.join(absDir, d.name), rel, recursive, out, depth + 1);
      continue;
    }

    const info = await stat(path.join(absDir, d.name)).catch(() => null);
    out.push({
      path: rel,
      bytes: info?.size ?? null,
      ext: path.extname(d.name).toLowerCase(),
    });
  }
}

/** 手写的极小 JSON Schema 校验，覆盖我们实际用到的子集。 */
function validate(schema, args) {
  const errors = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['参数必须是一个 JSON 对象'];
  }

  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) errors.push(`缺少必填参数 ${key}`);
  }

  const allowed = new Set(Object.keys(schema.properties ?? {}));
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) errors.push(`不认识的参数 ${key}（可用：${[...allowed].join(', ')}）`);
    }
  }

  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const value = args[key];
    if (value === undefined) continue;

    if (spec.type === 'string' && typeof value !== 'string') errors.push(`${key} 应该是字符串`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') errors.push(`${key} 应该是布尔值`);
    if (spec.type === 'number' && typeof value !== 'number') errors.push(`${key} 应该是数字`);
    if (spec.type === 'string' && typeof value === 'string' && value.trim() === '') {
      errors.push(`${key} 不能是空字符串`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      errors.push(`${key} 只能是 ${spec.enum.join(' / ')}`);
    }
  }

  return errors;
}