import type { RegisteredTool } from '@xm/kernel';

/**
 * Code Mode 那个工具的名字。
 *
 * 放在这里而不是 `turn-code.ts`：呈现模式（哪些工具进模型视野）与子调用派发都要用它，
 * 而那两个文件互为上下游。常量落在没有任何仓内依赖的这一侧，谁也不用绕。
 */
export const RUN_CODE = 'run_code';

/**
 * 从工具 schema 生成 Code Mode 的 SDK 声明（ADR-0061 §五）。
 *
 * ── 三条形状上的决定 ──
 *
 * 1. **同步签名，没有 `await`**（ADR-0069 §三.2）。asyncify 把宿主那侧的 async 折叠掉了；
 *    ADR-0061 §五 原话"生成成一个 TS 异步函数"是照参考实现写的，在这个隔离机制下不成立，
 *    而 `await` 那条路实测会让程序静默半途而废。
 * 2. **入参类型来自 `inputSchema`，返回类型来自 `outputSchema`**（Zod 原件，不是描述符）。
 *    规范值不进提示词（ADR-0071），所以描述符里根本没有它；这里手上有的是注册表本身。
 *    没声明 `outputSchema` 的工具（插件、MCP）返回 `unknown`——**不是编一个形状**。
 * 3. **点号变成嵌套对象**：`fs.read` → `xm.fs.read(...)`。JS 标识符里不能有点，
 *    而 `xm["fs.read"]` 那种写法模型写起来更容易出错。客体域里的 prelude 按同一规则装。
 *
 * 生成的是**给模型读的文本**，不是给 tsc 编译的文件。它只需要无歧义地说明形状。
 */

interface ZodDef {
  readonly type: string;
  readonly shape?: Record<string, unknown>;
  readonly innerType?: unknown;
  readonly element?: unknown;
  readonly options?: unknown[];
  readonly entries?: Record<string, unknown>;
  readonly values?: unknown[];
  readonly valueType?: unknown;
  readonly keyType?: unknown;
}

const defOf = (schema: unknown): ZodDef | undefined => {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const slot: unknown = (schema as { _zod?: unknown })._zod;
  if (typeof slot !== 'object' || slot === null) return undefined;
  const def: unknown = (slot as { def?: unknown }).def;
  if (typeof def !== 'object' || def === null) return undefined;
  return typeof (def as { type?: unknown }).type === 'string' ? (def as ZodDef) : undefined;
};

const describedBy = (schema: unknown): string | undefined => {
  const text: unknown = (schema as { description?: unknown }).description;
  return typeof text === 'string' && text !== '' ? text : undefined;
};

/** 这个字段能不能不填。`optional` 与 `default` 都算 */
const isSkippable = (schema: unknown): boolean => {
  const type = defOf(schema)?.type;
  return type === 'optional' || type === 'default';
};

/**
 * Zod → TypeScript 类型文本。
 *
 * 只覆盖 `assertToolSchema` 放行的那个可序列化子集（`docs/10 §5.2`）——子集之外的构造
 * 根本注册不进来，所以这里遇到未知类型就写 `unknown`，而不是猜。
 */
export function typeTextOf(schema: unknown, indent = ''): string {
  const def = defOf(schema);
  if (def === undefined) return 'unknown';
  switch (def.type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'literal':
      return (def.values ?? []).map((value) => JSON.stringify(value)).join(' | ');
    case 'enum':
      return Object.values(def.entries ?? {})
        .map((value) => JSON.stringify(value))
        .join(' | ');
    case 'optional':
    case 'default':
      return typeTextOf(def.innerType, indent);
    case 'nullable':
      return `${typeTextOf(def.innerType, indent)} | null`;
    case 'array':
      return arrayTextOf(def.element, indent);
    case 'record':
      return `Record<${typeTextOf(def.keyType, indent)}, ${typeTextOf(def.valueType, indent)}>`;
    case 'union':
      return (def.options ?? []).map((option) => typeTextOf(option, indent)).join(' | ');
    case 'object':
      return objectTextOf(def.shape ?? {}, indent);
    default:
      return 'unknown';
  }
}

/** 元素是对象时括起来：`{ a: string }[]` 在多行形态下容易读错 */
const arrayTextOf = (element: unknown, indent: string): string => {
  const text = typeTextOf(element, indent);
  return defOf(element)?.type === 'object' ? `Array<${text}>` : `${text}[]`;
};

function objectTextOf(shape: Record<string, unknown>, indent: string): string {
  const entries = Object.entries(shape);
  if (entries.length === 0) return '{}';
  const inner = `${indent}  `;
  const lines = entries.map(([key, child]) => {
    const comment = describedBy(child);
    const field = `${inner}${key}${isSkippable(child) ? '?' : ''}: ${typeTextOf(child, inner)};`;
    return comment === undefined ? field : `${field} // ${comment}`;
  });
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/**
 * 整段 SDK 文本。放进提示词里，替代 `code` 模式下不再发送的那一堆工具 schema。
 *
 * 层级按工具名的点号分段。同名分段下的工具排在一起，顺序随传入顺序——
 * 注册表本身是稳定的，所以这段文本对同一份工具集是**逐字节稳定**的，
 * 可以进 prompt cache 的稳定前缀（ADR-0006 关心的那件事）。
 */
export function generateToolSdk(tools: readonly RegisteredTool[]): string {
  const groups = new Map<string, RegisteredTool[]>();
  const flat: RegisteredTool[] = [];
  for (const tool of tools) {
    const dot = tool.descriptor.name.indexOf('.');
    if (dot < 0) {
      flat.push(tool);
      continue;
    }
    const head = tool.descriptor.name.slice(0, dot);
    const bucket = groups.get(head) ?? [];
    bucket.push(tool);
    groups.set(head, bucket);
  }

  const lines: string[] = ['declare const xm: {'];
  for (const tool of flat) lines.push(...memberLines(tool, tool.descriptor.name, '  '));
  for (const [head, bucket] of groups) {
    lines.push(`  ${head}: {`);
    for (const tool of bucket) {
      lines.push(...memberLines(tool, tool.descriptor.name.slice(head.length + 1), '    '));
    }
    lines.push('  };');
  }
  lines.push('};');
  return lines.join('\n');
}

function memberLines(tool: RegisteredTool, member: string, indent: string): string[] {
  const name = member.replace(/\./g, '_');
  const output = tool.outputSchema === undefined ? 'unknown' : typeTextOf(tool.outputSchema, indent);
  return [
    `${indent}/** ${tool.descriptor.description} */`,
    `${indent}${name}(input: ${typeTextOf(tool.inputSchema, indent)}): ${output};`,
  ];
}

/**
 * `code` / `both` 两种呈现模式下追加到系统提示词的那一段（ADR-0061 §二）。
 *
 * 它讲三件事，每一件都对应一种模型实际会犯的错：不写 `await`（写了就静默半途而废）、
 * 用 `return` 交回结果（不写就什么也拿不到）、被拒的调用会抛异常（可以 catch 接着走）。
 */
export const codeModeGuidance = (sdk: string): string =>
  `你可以用 run_code 写一段 TypeScript，一次调用里连做多步，省掉逐步往返。\n` +
  `规则：\n` +
  `· 程序是一个**同步**函数体。所有工具调用都是同步的，**不要写 await、不要写 import**。\n` +
  `· 用 \`return\` 把最终结果交回来；只有它和 console.log 的内容会被你看到，\n` +
  `  中间变量不会——所以读了很多东西时，自己先归纳再 return。\n` +
  `· 被拒绝的调用会抛异常（\`e.message\` 是拒绝理由，\`e.code\` 是错误码），可以 catch 后换个做法。\n` +
  `· 程序里时间不流逝、随机数由宿主给定，别用它们做超时或重试退避。\n` +
  `可用的工具：\n\`\`\`ts\n${sdk}\n\`\`\``;
