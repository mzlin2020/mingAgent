import { z } from 'zod';

/**
 * 工具入参 schema 的**可序列化子集**断言与 JSON Schema 导出（ADR-0009 / docs/10 §5.2）。
 *
 * 工具入参要同时满足三件事：Zod 严格校验、导出 JSON Schema 给模型、跨进程传输。
 * 不是所有 Zod 构造都能做到，所以我们只允许一个子集。
 */

/** 允许出现在工具入参里的 Zod 内部类型 */
const ALLOWED_TYPES = new Set([
  'object', // 且必须是 strictObject，见下
  'string',
  'number',
  'boolean',
  'enum',
  'literal',
  'array',
  'optional',
  'nullable',
  'default',
  'union', // 且必须带 discriminator
  'record',
  'null',
]);

/** 明确禁止的构造 → 给出人话原因，开发期就能改对 */
const FORBIDDEN_REASONS: Readonly<Record<string, string>> = {
  any: 'z.any() 等于没有约束，模型必然乱填。请写出具体形状。',
  unknown: 'z.unknown() 等于没有约束，模型必然乱填。请写出具体形状。',
  pipe: '.transform() 让输入输出类型不一致，Tool<I> 的 I 就失去了意义。请在工具实现里做转换。',
  lazy: '递归 schema 导出的 JSON Schema 带 $ref，各家模型支持参差。请用非递归的扁平结构。',
  tuple: '元组模型很难稳定产出。请改用定长 array 或具名对象。',
  map: 'Map 不可 JSON 序列化。请用 record 或对象数组。',
  set: 'Set 不可 JSON 序列化。请用 array。',
  function: '函数不可跨进程传输。',
  date: 'Date 不可 JSON 序列化。请用 ISO 字符串（z.string()）并在 description 里说明格式。',
  promise: '入参不能是异步值。',
  never: 'z.never() 让该字段永远无法填写。',
  void: 'z.void() 在入参里没有意义。',
  symbol: 'Symbol 不可序列化。',
  bigint: 'BigInt 不可 JSON 序列化。请用 number 或字符串。',
  nan: 'NaN 不可 JSON 序列化。',
  intersection: '交叉类型导出的 JSON Schema 是 allOf，模型支持参差。请手工合并成一个对象。',
};

/** 断言失败时抛出的错误。刻意用普通 Error：这是开发期错误，不该进事件流。 */
export class ToolSchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`工具入参 schema 非法${path === '' ? '' : `（位于 ${path}）`}：${message}`);
    this.name = 'ToolSchemaError';
    this.path = path;
  }
}

interface ZodInternalDef {
  type: string;
  shape?: Record<string, unknown>;
  catchall?: unknown;
  innerType?: unknown;
  element?: unknown;
  options?: unknown[];
  discriminator?: string;
  valueType?: unknown;
  keyType?: unknown;
}

/** 读 Zod 4 的内部 def。见文件末尾关于"半公开 API"的说明。 */
function defOf(schema: unknown): ZodInternalDef | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const zodSlot: unknown = (schema as { _zod?: unknown })._zod;
  if (typeof zodSlot !== 'object' || zodSlot === null) return undefined;
  const def: unknown = (zodSlot as { def?: unknown }).def;
  if (typeof def !== 'object' || def === null) return undefined;
  const typeField: unknown = (def as { type?: unknown }).type;
  if (typeof typeField !== 'string') return undefined;
  return def as ZodInternalDef;
}

/**
 * 校验一个 Zod schema 是否落在合法子集内，不合法直接抛出。
 * 由 ToolRegistry.register() 在**注册时**调用——开发期就炸，而不是等模型在生产里
 * 填出一个诡异参数才发现。
 *
 * ⚠️ **不能用"z.toJSONSchema 是否抛错"来代替本函数**（docs/10 §5.2 实测）：
 *   - `.transform()` 在 io:'output' 下抛错，但在我们实际用的 io:'input' 下**静默通过**
 *   - `z.any()` 产出 `{}`——语法合法，语义零约束
 *   - `z.lazy()` 递归产出 `{"$ref":"#"}`——语法合法
 * 三者导出全不报错，只能靠结构化遍历拦下。
 */
export function assertToolSchema(schema: unknown, path = ''): void {
  const def = defOf(schema);
  if (def === undefined) {
    throw new ToolSchemaError(path, '不是一个 Zod schema');
  }

  const forbidden = FORBIDDEN_REASONS[def.type];
  if (forbidden !== undefined) {
    throw new ToolSchemaError(path, forbidden);
  }
  if (!ALLOWED_TYPES.has(def.type)) {
    throw new ToolSchemaError(
      path,
      `不支持的构造 \`${def.type}\`。允许的子集见 docs/10 §5.2；确需放开请写 ADR。`,
    );
  }

  switch (def.type) {
    case 'object': {
      // strictObject 的 catchall 是 z.never()，looseObject 是 z.unknown()，
      // 裸 z.object() 没有 catchall——后两者都不可接受。
      const catchallType = defOf(def.catchall)?.type;
      if (catchallType !== 'never') {
        throw new ToolSchemaError(
          path,
          catchallType === undefined
            ? '必须用 z.strictObject()。裸 z.object() 是 strip 模式，会静默丢弃模型多填的字段，' +
              '让它以为参数生效了（参考项目 2.7 的坑）。'
            : '必须用 z.strictObject()，不能用 z.looseObject()。模型多填的字段说明它在幻觉，必须报错。',
        );
      }
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        assertToolSchema(child, path === '' ? key : `${path}.${key}`);
      }
      return;
    }

    case 'union': {
      if (typeof def.discriminator !== 'string') {
        throw new ToolSchemaError(
          path,
          '裸 union 模型极难稳定产出。请用 z.discriminatedUnion()，且各分支均为 strictObject。',
        );
      }
      for (const [i, option] of (def.options ?? []).entries()) {
        assertToolSchema(option, `${path}[${String(i)}]`);
      }
      return;
    }

    case 'optional':
    case 'nullable':
    case 'default':
      assertToolSchema(def.innerType, path);
      return;

    case 'array':
      assertToolSchema(def.element, `${path}[]`);
      return;

    case 'record':
      assertToolSchema(def.keyType, `${path}{key}`);
      assertToolSchema(def.valueType, `${path}{value}`);
      return;

    default:
      // 标量（string/number/boolean/enum/literal/null）没有子节点，到此为止
      return;
  }
}

/**
 * 导出给模型的 JSON Schema。
 *
 * 🔴 **`io: 'input'` 是必须的。** 默认 `io: 'output'` 下，带 `.default()` 的字段
 * **一律进 `required`**——模型会被告知这些可选参数是必填的，每次都得填，
 * 纯属浪费 token 且徒增出错面。（2026-08-04 实测对照：`replaceAll` 有 default，
 * output 视角下进了 required，input 视角下正确地不在。）
 *
 * `reused: 'inline'` 保证同一个子 schema 被引用两次时不会退化成 `$defs` + `$ref`。
 */
export function toModelSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', reused: 'inline' }) as Record<string, unknown>;
  // $schema 对模型没有信息量，只占 token
  const { $schema: _dropped, ...rest } = json;
  void _dropped;
  return rest;
}
