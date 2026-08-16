import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/index.js';

/**
 * 工具的**规范输出值**契约（ADR-0071 / `docs/10 §9.5.4`）。
 *
 * 这一组守的是三句话：
 *
 * 1. 规范值与入参落在**同一个可序列化子集**里——它要跨 QuickJS 客体域边界。
 * 2. 顶层必须是对象——标量与数组没法在不破坏已有程序的前提下加字段。
 * 3. **没声明 schema 就没有规范值**，校验不过也没有（失败关闭）。
 *
 * 第 3 条是最容易被将来的人"顺手放开"的一条：丢掉一个形状不对的对象看起来很浪费。
 * 但它的消费者是程序，而程序拿到一个字段名对不上的对象会读出一串 `undefined` 继续跑，
 * 那比拿不到糟得多——拿不到至少能被 catch、能被断言。
 */

const Input = z.strictObject({ path: z.string() });

const toolWith = (outputSchema?: z.ZodType) =>
  defineTool({
    name: 'test.output',
    group: 'test',
    description: '规范输出值测试',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['env.read'],
    ...(outputSchema === undefined ? {} : { outputSchema }),
    // eslint-disable-next-line require-yield
    async *execute() {
      await Promise.resolve();
      throw new Error('本组用例不执行工具');
    },
  });

describe('规范输出值的注册期约束', () => {
  it('顶层是标量：注册时就炸，并说清楚该包一层', () => {
    expect(() => toolWith(z.string())).toThrow(/顶层是 `string`，必须是 z\.strictObject/u);
  });

  it('顶层是数组：同样拒绝——加字段会破坏所有已经写好的程序', () => {
    expect(() => toolWith(z.array(z.strictObject({ a: z.string() })))).toThrow(
      /必须是 z\.strictObject/u,
    );
  });

  it('用了子集外的构造：报错措辞说的是"规范输出值"，不是"入参"', () => {
    expect(() => toolWith(z.strictObject({ when: z.date() }))).toThrow(
      /工具规范输出值 schema 非法（位于 when）：Date 不可 JSON 序列化/u,
    );
  });

  it('嵌套对象也必须 strict：一个 z.object() 藏在里面同样拒绝', () => {
    expect(() => toolWith(z.strictObject({ inner: z.object({ a: z.string() }) }))).toThrow(
      /规范输出值 schema 非法（位于 inner）/u,
    );
  });

  it('合法的 strictObject 顺利注册，并把 schema 原件留给 SDK 生成用', () => {
    const schema = z.strictObject({ path: z.string(), bytes: z.number().int() });
    const tool = toolWith(schema);
    expect(tool.outputSchema).toBe(schema);
  });
});

describe('规范输出值的失败关闭', () => {
  it('没声明 schema：工具 yield 出来的规范值一律丢掉', () => {
    const tool = toolWith();
    expect(tool.outputSchema).toBeUndefined();
    expect(tool.parseOutput({ path: '/w/a.txt' })).toBeUndefined();
  });

  it('校验不过：丢掉，不抛也不半信半疑地放行', () => {
    const tool = toolWith(z.strictObject({ path: z.string() }));
    expect(tool.parseOutput({ path: 7 })).toBeUndefined();
    expect(tool.parseOutput({ path: '/w/a.txt', extra: 1 })).toBeUndefined();
    expect(tool.parseOutput(undefined)).toBeUndefined();
  });

  it('校验得过：原样拿到，可选字段缺席不影响', () => {
    const tool = toolWith(
      z.strictObject({ path: z.string(), bytes: z.number().int().optional() }),
    );
    expect(tool.parseOutput({ path: '/w/a.txt' })).toEqual({ path: '/w/a.txt' });
    expect(tool.parseOutput({ path: '/w/a.txt', bytes: 3 })).toEqual({ path: '/w/a.txt', bytes: 3 });
  });
});
