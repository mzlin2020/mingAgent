import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolSchemaError, assertToolSchema, toModelSchema } from '@xm/contracts';

/** 一个贴近真实的工具入参：嵌套对象数组 + 枚举 + 可选 + default */
const EditInput = z.strictObject({
  path: z.string().describe('要编辑的文件绝对路径'),
  edits: z
    .array(
      z.strictObject({
        oldText: z.string().describe('要被替换的原文，必须在文件中唯一出现'),
        newText: z.string().describe('替换成的新内容'),
        replaceAll: z.boolean().default(false).describe('是否替换所有匹配项'),
      }),
    )
    .min(1)
    .describe('批量编辑列表，按顺序应用'),
  encoding: z.enum(['utf8', 'utf16le', 'latin1']).optional().describe('文件编码，默认 utf8'),
});

const SearchInput = z.strictObject({
  query: z.string().describe('搜索词'),
  mode: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('regex'), flags: z.string().optional() }),
      z.strictObject({ kind: z.literal('literal'), caseSensitive: z.boolean().default(false) }),
    ])
    .describe('匹配模式'),
  maxResults: z.number().int().min(1).max(1000).default(50),
});

describe('assertToolSchema：合法子集', () => {
  it('接受嵌套对象、数组、枚举、可选、default', () => {
    expect(() => {
      assertToolSchema(EditInput);
    }).not.toThrow();
  });

  it('接受判别联合', () => {
    expect(() => {
      assertToolSchema(SearchInput);
    }).not.toThrow();
  });
});

describe('assertToolSchema：违规构造必须被拦下', () => {
  /**
   * 🔴 这组测试的核心不是"这些写法被拒了"，而是**为什么不能用导出报错来判断**。
   *
   * 下面每个违规样例都会先断言 `toModelSchema()` **不抛错**——也就是说，
   * 如果 assertToolSchema 偷懒写成 try/catch 包一层导出，这些全都会漏过去。
   * 结构化遍历是唯一可行的做法（docs/10 §5.2 实测结论）。
   */
  const cases: readonly { name: string; schema: unknown; hint: RegExp }[] = [
    {
      name: '.transform()',
      schema: z.strictObject({ n: z.string().transform(Number) }),
      hint: /transform/,
    },
    { name: 'z.any()', schema: z.strictObject({ p: z.any() }), hint: /z\.any\(\)/ },
    { name: 'z.unknown()', schema: z.strictObject({ p: z.unknown() }), hint: /z\.unknown\(\)/ },
    {
      name: 'z.lazy() 递归',
      schema: z.lazy(() => z.strictObject({ a: z.string() })),
      hint: /递归/,
    },
    { name: '裸 z.object()', schema: z.object({ a: z.string() }), hint: /strictObject/ },
    { name: 'z.looseObject()', schema: z.looseObject({ a: z.string() }), hint: /strictObject/ },
    {
      name: '裸 union',
      schema: z.strictObject({ u: z.union([z.string(), z.number()]) }),
      hint: /discriminatedUnion/,
    },
    { name: 'z.date()', schema: z.strictObject({ d: z.date() }), hint: /Date/ },
    { name: 'z.tuple()', schema: z.strictObject({ t: z.tuple([z.string()]) }), hint: /元组/ },
  ];

  for (const { name, schema, hint } of cases) {
    it(`${name} 被拒绝`, () => {
      expect(() => {
        assertToolSchema(schema);
      }).toThrow(ToolSchemaError);
      expect(() => {
        assertToolSchema(schema);
      }).toThrow(hint);
    });
  }

  it('关键：三类违规在 io:"input" 下导出都不抛错——所以不能靠导出来判定', () => {
    const silentlyExportable = [
      z.strictObject({ n: z.string().transform(Number) }),
      z.strictObject({ p: z.any() }),
      z.lazy((): z.ZodType => z.strictObject({ a: z.string() })),
    ];
    for (const s of silentlyExportable) {
      expect(() => toModelSchema(s)).not.toThrow();
      expect(() => {
        assertToolSchema(s);
      }).toThrow(ToolSchemaError);
    }
  });

  it('错误信息里带字段路径', () => {
    try {
      assertToolSchema(z.strictObject({ outer: z.strictObject({ inner: z.any() }) }));
      expect.unreachable('应当抛出');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolSchemaError);
      expect((e as ToolSchemaError).path).toBe('outer.inner');
    }
  });
});

describe('toModelSchema：JSON Schema 往返', () => {
  it('带 .default() 的字段不在 required 里（io:"input" 的全部意义）', () => {
    const json = toModelSchema(EditInput);
    const edits = (json.properties as Record<string, Record<string, unknown>>).edits!;
    const item = edits.items as { required?: string[] };

    expect(json.required).toEqual(['path', 'edits']);
    expect(item.required).toEqual(['oldText', 'newText']);
    expect(item.required).not.toContain('replaceAll');
  });

  it('io 默认值（output）会把 default 字段错误地列进 required —— 反向验证', () => {
    const wrong = z.toJSONSchema(EditInput) as { properties: Record<string, { items?: { required?: string[] } }> };
    expect(wrong.properties.edits?.items?.required).toContain('replaceAll');
  });

  it('additionalProperties: false 正确生成', () => {
    const json = toModelSchema(EditInput);
    expect(json.additionalProperties).toBe(false);
  });

  it('无 $ref / $defs —— 跨模型兼容的底线', () => {
    for (const s of [EditInput, SearchInput]) {
      const text = JSON.stringify(toModelSchema(s));
      expect(text).not.toContain('$ref');
      expect(text).not.toContain('$defs');
    }
  });

  it('同一子 schema 被引用两次也不退化成 $ref', () => {
    const Shared = z.strictObject({ a: z.string() });
    const text = JSON.stringify(toModelSchema(z.strictObject({ x: Shared, y: Shared })));
    expect(text).not.toContain('$ref');
  });

  it('中文 .describe() 无损落到 description', () => {
    const json = toModelSchema(EditInput);
    const props = json.properties as Record<string, { description?: string }>;
    expect(props.path?.description).toBe('要编辑的文件绝对路径');
  });

  it('判别联合导出为 anyOf/oneOf 且判别键是 const', () => {
    const json = toModelSchema(SearchInput);
    const mode = (json.properties as Record<string, Record<string, unknown>>).mode!;
    const branches = (mode.anyOf ?? mode.oneOf) as { properties: { kind: { const: string } } }[];
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => b.properties.kind.const).sort()).toEqual(['literal', 'regex']);
  });

  it('不带 $schema —— 对模型没有信息量，只占 token', () => {
    expect(toModelSchema(EditInput)).not.toHaveProperty('$schema');
  });
});

describe('入参严格性：模型幻觉字段必须报错', () => {
  it('多填的字段触发 unrecognized_keys', () => {
    const result = EditInput.safeParse({
      path: '/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
      hallucinatedOption: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.code)).toContain('unrecognized_keys');
  });

  it('合法入参照常通过，且 default 被填上', () => {
    const result = EditInput.parse({ path: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }] });
    expect(result.edits[0]?.replaceAll).toBe(false);
  });
});
