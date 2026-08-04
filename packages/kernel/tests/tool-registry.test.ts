import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import { ToolSchemaError } from '@xm/contracts';
import { ToolInputError, ToolRegistry, defineTool } from '@xm/kernel';
import type { ToolContext } from '@xm/kernel';

const ctx: ToolContext = {
  signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
  cwd: '/work',
  executor: 'local',
};

const readTool = () =>
  defineTool({
    name: 'fs.read',
    group: 'fs',
    description: '读取文件内容',
    inputSchema: z.strictObject({
      path: z.string().describe('绝对路径'),
      encoding: z.enum(['utf8', 'latin1']).default('utf8'),
    }),
    risk: 'safe',
    capabilities: ['fs.read'],
    resources: (input) => [{ kind: 'path', mode: 'read', glob: input.path }],
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async function* (input): AsyncIterable<ToolProgress> {
      yield { kind: 'result', forModel: [{ type: 'text', text: `内容 of ${input.path}` }] };
    },
  });

describe('defineTool', () => {
  it('注册时就校验 schema 子集，违规直接抛出（不等模型在生产里踩）', () => {
    expect(() =>
      defineTool({
        name: 'bad.tool',
        group: 'bad',
        description: '坏工具',
        inputSchema: z.strictObject({ anything: z.any() }),
        risk: 'safe',
        capabilities: [],
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async function* (): AsyncIterable<ToolProgress> {
          yield { kind: 'result', forModel: [] };
        },
      }),
    ).toThrow(ToolSchemaError);
  });

  it('描述符里的 inputSchema 是导出好的 JSON Schema，default 不在 required', () => {
    const tool = readTool();
    const json = tool.descriptor.inputSchema as { required: string[] };
    expect(json.required).toEqual(['path']);
  });

  it('声明了 resources 的工具默认 parallel，没声明的降级为 exclusive（ADR-0005）', () => {
    expect(readTool().descriptor.concurrency).toBe('parallel');

    const noResources = defineTool({
      name: 'x.y',
      group: 'x',
      description: 'd',
      inputSchema: z.strictObject({}),
      risk: 'safe',
      capabilities: [],
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async function* (): AsyncIterable<ToolProgress> {
        yield { kind: 'result', forModel: [] };
      },
    });
    expect(noResources.descriptor.concurrency).toBe('exclusive');
  });

  it('入参在执行前被 strict 校验，幻觉字段被拒', async () => {
    const tool = readTool();
    await expect(async () => {
      for await (const _ of tool.execute({ path: '/a', hallucinated: 1 }, ctx)) {
        void _;
      }
    }).rejects.toThrow(ToolInputError);
  });

  it('合法入参正常执行，default 被填上', async () => {
    const tool = readTool();
    const out: ToolProgress[] = [];
    for await (const p of tool.execute({ path: '/a' }, ctx)) out.push(p);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'result' });
  });

  it('resources() 也走同一套校验', () => {
    const tool = readTool();
    expect(tool.resources({ path: '/a' })).toEqual([{ kind: 'path', mode: 'read', glob: '/a' }]);
    expect(() => tool.resources({ nope: 1 })).toThrow(ToolInputError);
  });

  it('默认结果上限 64KB / middle', () => {
    expect(readTool().descriptor.resultLimits).toMatchObject({
      maxBytes: 64 * 1024,
      strategy: 'middle',
    });
  });

  it('默认来源是 builtin', () => {
    expect(readTool().descriptor.source).toEqual({ kind: 'builtin' });
  });
});

describe('ToolRegistry', () => {
  it('注册与查找', () => {
    const reg = new ToolRegistry();
    reg.register(readTool());
    expect(reg.has('fs.read')).toBe(true);
    expect(reg.size).toBe(1);
    expect(reg.descriptors().map((d) => d.name)).toEqual(['fs.read']);
  });

  it('重名直接报错 —— 插件与 MCP 工具必须带自己的前缀', () => {
    const reg = new ToolRegistry();
    reg.register(readTool());
    expect(() => {
      reg.register(readTool());
    }).toThrow(/工具名冲突/);
  });

  it('可以注销（插件卸载路径）', () => {
    const reg = new ToolRegistry();
    reg.register(readTool());
    expect(reg.unregister('fs.read')).toBe(true);
    expect(reg.size).toBe(0);
  });
});
