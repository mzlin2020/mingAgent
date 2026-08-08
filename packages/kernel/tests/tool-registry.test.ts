import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import { ToolSchemaError } from '@xm/contracts';
import {
  EMPTY_CAPABILITIES_ALLOWLIST,
  ToolInputError,
  ToolRegistry,
  UnlistedEmptyCapabilitiesError,
  defineTool,
} from '@xm/kernel';
import type { ToolAvailabilityContext, ToolContext } from '@xm/kernel';
import { ALL_CAPABILITIES, newSessionId } from '@xm/contracts';

const ctx: ToolContext = {
  sessionId: newSessionId(),
  signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
  cwd: '/work',
  executor: 'local',
};

/** 默认可用性上下文：平台什么都支持、什么都没禁用 */
const availCtx = (over: Partial<ToolAvailabilityContext> = {}): ToolAvailabilityContext => ({
  cwd: '/work',
  executor: 'local',
  platformCapabilities: ALL_CAPABILITIES,
  disabledTools: [],
  ...over,
});

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
      // 这条测试只关心 concurrency 默认值（只看 spec.resources，与 capabilities
      // 无关），随便给一个非空能力即可，不要撞上 ADR-0032 #5 的空能力集白名单检查
      capabilities: ['fs.read'],
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

/**
 * 动态可用性（docs/04 §4.3）。
 *
 * 这个字段之前**只存在于文档和注释里**——ADR-0006 的派生约束提它、ToolRegistry
 * 的注释提它、docs/04 的接口草案写了它，唯独 `ToolSpec` 上没有。于是
 * "Linux 上 computer 工具从模型视野消失"（ADR-0007 Tier 3）这条根本无法表达。
 */
describe('工具可用性过滤', () => {
  const guiTool = () =>
    defineTool({
      name: 'computer.click',
      group: 'computer',
      description: '点击屏幕坐标',
      inputSchema: z.strictObject({ x: z.number(), y: z.number() }),
      risk: 'high',
      capabilities: ['gui.input'],
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async function* (): AsyncIterable<ToolProgress> {
        yield { kind: 'result', forModel: [] };
      },
    });

  it('不传上下文时给出全量列表', () => {
    const r = new ToolRegistry();
    r.register(guiTool());
    expect(r.descriptors()).toHaveLength(1);
  });

  it('🔴 平台不支持所需能力 → 工具不进模型视野', () => {
    const r = new ToolRegistry();
    r.register(guiTool());
    const platformCapabilities = ALL_CAPABILITIES.filter((c) => c !== 'gui.input');
    expect(r.descriptors(availCtx({ platformCapabilities }))).toHaveLength(0);
  });

  it('🔴 配置禁用优先于工具自己的判断', () => {
    const r = new ToolRegistry();
    r.register(
      defineTool({
        name: 'fs.list',
        group: 'fs',
        description: '列目录',
        inputSchema: z.strictObject({ path: z.string() }),
        risk: 'safe',
        capabilities: ['fs.read'],
        // 工具坚称自己永远可用——也拦不住用户关掉它
        available: () => true,
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async function* (): AsyncIterable<ToolProgress> {
          yield { kind: 'result', forModel: [] };
        },
      }),
    );
    expect(r.descriptors(availCtx({ disabledTools: ['fs.list'] }))).toHaveLength(0);
  });

  it('工具自报不可用（如无 git 仓库）时也不暴露', () => {
    const r = new ToolRegistry();
    r.register(
      defineTool({
        name: 'git.status',
        group: 'git',
        description: '查看仓库状态',
        inputSchema: z.strictObject({}),
        risk: 'safe',
        capabilities: ['fs.read'],
        available: (ctx) => ctx.cwd.startsWith('/repo'),
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async function* (): AsyncIterable<ToolProgress> {
          yield { kind: 'result', forModel: [] };
        },
      }),
    );
    expect(r.descriptors(availCtx({ cwd: '/tmp' }))).toHaveLength(0);
    expect(r.descriptors(availCtx({ cwd: '/repo/x' }))).toHaveLength(1);
  });
});

describe('声明空能力集必须显式登记（ADR-0032 #5）', () => {
  const emptyCapTool = (name: string) =>
    defineTool({
      name,
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

  it('🔴 未登记的工具声明空能力集：注册时就炸，不是等到判权那一刻才发现绕过了闸门', () => {
    expect(() => emptyCapTool('some.new.tool.nobody.reviewed')).toThrow(UnlistedEmptyCapabilitiesError);
  });

  it('错误信息指向白名单该改哪个文件，不是一句"不行"就完事', () => {
    try {
      emptyCapTool('another.unlisted.tool');
      expect.unreachable('应该抛出');
    } catch (e) {
      expect(e).toBeInstanceOf(UnlistedEmptyCapabilitiesError);
      expect((e as Error).message).toContain('EMPTY_CAPABILITIES_ALLOWLIST');
      expect((e as UnlistedEmptyCapabilitiesError).toolName).toBe('another.unlisted.tool');
    }
  });

  it('已登记的工具名不受影响，正常定义成功', () => {
    for (const name of Object.keys(EMPTY_CAPABILITIES_ALLOWLIST)) {
      expect(() => emptyCapTool(name)).not.toThrow();
    }
  });

  it('白名单里每一条都写明了理由（ADR 编号或 test-fixture/说明），不是空字符串', () => {
    for (const [name, reason] of Object.entries(EMPTY_CAPABILITIES_ALLOWLIST)) {
      expect(reason.length, `${name} 的登记理由不该是空的`).toBeGreaterThan(0);
    }
  });

  it('非空能力集不受这条规则约束，正常工具完全不用管这张白名单', () => {
    expect(() =>
      defineTool({
        name: 'normal.tool',
        group: 'x',
        description: 'd',
        inputSchema: z.strictObject({}),
        risk: 'safe',
        capabilities: ['fs.read'],
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async function* (): AsyncIterable<ToolProgress> {
          yield { kind: 'result', forModel: [] };
        },
      }),
    ).not.toThrow();
  });
});
