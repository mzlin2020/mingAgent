import { realpath as realpathCb } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PermissionRequest, PolicyRuleSet } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { PolicyEnv, RegisteredTool, ToolContext } from '@xm/kernel';
import { GatewayError, builtinLayers, defineTool, evaluate, normalizedOrThrow } from '@xm/kernel';
import { nodeToolGateway } from '@xm/tools-core';

/**
 * ── 能力网关（ADR-0024）──
 *
 * 这个文件里最要紧的是第一组：**符号链接**。
 * 内核的规范化是纯词法的，它看到的 `/work/link/id_rsa` 就是工作区内的一个路径，
 * 于是完全合规地放行。ADR-0012 与 ADR-0018 都把这一半推给"运行时的能力网关"，
 * 而在此之前那个网关不存在——两份 ADR 的分工，只有一半有实现。
 */

let root: string;
let outside: string;

const ctx = (cwd: string): ToolContext => ({
  sessionId: newSessionId(),
  signal: { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined },
  cwd,
  executor: 'local',
});

const tool = (over: Partial<Parameters<typeof defineTool>[0]> = {}): RegisteredTool =>
  defineTool({
    name: 'fs.probe',
    group: 'fs',
    description: '探针',
    inputSchema: z.strictObject({ path: z.string(), other: z.string().optional() }),
    risk: 'safe',
    capabilities: ['fs.read'],
    pathInputs: ['path'],
    // eslint-disable-next-line @typescript-eslint/require-await
    async *execute() {
      yield { kind: 'result' as const, forModel: [] };
    },
    ...over,
  });

beforeAll(async () => {
  /*
   * ⚠️ 临时目录**必须先 realpath.native**，两个平台各有各的理由：
   *   · macOS：`/tmp` 自己是指向 `/private/tmp` 的符号链接；
   *   · Windows：`os.tmpdir()` 返回 8.3 短名（`C:\Users\RUNNER~1\...`），
   *     而内核对短名是**失败关闭**的——用它当规则模式，规则匹配不上；
   *     用它当请求 target，判定直接 deny。
   * 生产路径上这件事由 `resolvePaths()` 做（platform/paths.ts），用例里没有它，
   * 于是得自己走同一步。不走的后果是断言测的不是它想测的东西。
   */
  root = await realNative(await mkdtemp(join(tmpdir(), 'xm-gateway-')));
  outside = await realNative(await mkdtemp(join(tmpdir(), 'xm-secret-')));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(outside, 'id_rsa'), 'PRIVATE KEY\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('🔴 符号链接：判定必须落在链接指向的地方', () => {
  it('工作区内指向外部文件的链接，解析成外部的真实路径', async () => {
    await symlink(join(outside, 'id_rsa'), join(root, 'looks-innocent.txt'));

    const resolved = await nodeToolGateway().resolve(
      tool(),
      { path: 'looks-innocent.txt' },
      ctx(root),
    );

    // 关键断言：target 不是工作区里那个人畜无害的名字
    expect(resolved.target).not.toContain('looks-innocent');
    expect(resolved.target).toBe(await realOf(join(outside, 'id_rsa')));
  });

  it('穿过符号链接目录的路径同样被解析', async () => {
    await symlink(outside, join(root, 'link-dir'));
    const resolved = await nodeToolGateway().resolve(
      tool(),
      { path: 'link-dir/id_rsa' },
      ctx(root),
    );
    expect(resolved.target).toBe(await realOf(join(outside, 'id_rsa')));
  });

  it('🔴 没有网关时，同一条规则拦不住它 —— 这就是网关存在的全部理由', () => {
    const ENV: PolicyEnv = { home: '/home/ming', appRoot: '/repo', dataDir: '/tmp/xm-data' };
    const deny: PolicyRuleSet = [
      {
        id: 'user.no-secrets',
        effect: 'deny',
        capability: 'fs.read',
        match: { target: `${outside}/**` },
        reason: '不许读这个目录',
        immutable: false,
      },
    ];
    const layers = [...builtinLayers(ENV), { id: 'user' as const, rules: deny }];
    const ask = (target: string): PermissionRequest => ({
      requestId: newRequestId(),
      sessionId: newSessionId(),
      capability: 'fs.read',
      target,
      risk: 'safe',
      reason: '测试',
      trustLevel: 'model',
    });

    // 未解析：工作区内的一个普通路径 → 规则完全匹配不上
    expect(evaluate({ request: ask(join(root, 'looks-innocent.txt')), layers, tier: 'balanced' }).effect)
      .toBe('allow');
    // 解析之后：命中 deny
    expect(evaluate({ request: ask(join(outside, 'id_rsa')), layers, tier: 'balanced' }).effect)
      .toBe('deny');
  });
});

describe('解析规则', () => {
  it('相对路径按会话的 cwd 绝对化', async () => {
    const r = await nodeToolGateway().resolve(tool(), { path: 'src/a.ts' }, ctx(root));
    expect(r.target).toBe(await realOf(join(root, 'src', 'a.ts')));
  });

  it('.. 被消解', async () => {
    const r = await nodeToolGateway().resolve(tool(), { path: 'src/../src/a.ts' }, ctx(root));
    expect(r.target).toBe(await realOf(join(root, 'src', 'a.ts')));
  });

  it('🔴 还不存在的文件也能解析 —— 否则 fs.write 永远新建不了文件', async () => {
    const r = await nodeToolGateway().resolve(tool(), { path: 'src/new/deep/x.md' }, ctx(root));
    expect(r.target).toBe(await realOf(join(root, 'src'), 'new', 'deep', 'x.md'));
  });

  it('🔴 不存在的文件穿过符号链接目录时，链接那一段仍然被解析', async () => {
    // 这一条是"取最深的存在祖先"真正要保证的东西：
    // 逃逸的载体是**已经存在**的那一段，剩下的段按定义没有链接可解
    const r = await nodeToolGateway().resolve(tool(), { path: 'link-dir/brand-new.txt' }, ctx(root));
    expect(r.target).toBe(await realOf(outside, 'brand-new.txt'));
  });

  it('🔴 入参被回写 —— 判定与执行用的是同一个字符串', async () => {
    const r = await nodeToolGateway().resolve(tool(), { path: 'src/a.ts', other: 'x' }, ctx(root));
    expect((r.input as { path: string }).path).toBe(r.target);
    // 非路径字段原样保留
    expect((r.input as { other: string }).other).toBe('x');
  });

  it('pathInputs 的第一个字段是判权 target', async () => {
    const t = tool({
      inputSchema: z.strictObject({ src: z.string(), dst: z.string() }),
      pathInputs: ['dst', 'src'],
    });
    const r = await nodeToolGateway().resolve(t, { src: 'src/a.ts', dst: 'out.txt' }, ctx(root));
    expect(r.target).toBe(await realOf(root, 'out.txt'));
    expect((r.input as { src: string }).src).toBe(await realOf(join(root, 'src', 'a.ts')));
  });
});

describe('🔴 失败关闭', () => {
  it('声明了路径类能力却没声明 pathInputs → 拒绝，不是放行', async () => {
    const t = tool({ pathInputs: [] });
    await expect(nodeToolGateway().resolve(t, { path: 'src/a.ts' }, ctx(root))).rejects.toThrow(
      GatewayError,
    );
  });

  it('不碰路径的工具照常放行，target 为空', async () => {
    const t = tool({ capabilities: [], pathInputs: [] });
    const r = await nodeToolGateway().resolve(t, { path: 'whatever' }, ctx(root));
    expect(r.target).toBe('');
  });

  it('cwd 不是绝对路径 → 拒绝', async () => {
    await expect(
      nodeToolGateway().resolve(tool(), { path: 'a.ts' }, ctx('relative/dir')),
    ).rejects.toThrow(/工作目录/);
  });

  it('路径字段不是字符串 → 拒绝', async () => {
    await expect(
      nodeToolGateway().resolve(tool(), { path: 42 }, ctx(root)),
    ).rejects.toThrow(/非空路径字符串/);
  });
});

const realNative = promisify(realpathCb.native);

/**
 * 期望值走**与网关同一条路**：realpath.native → 内核规范化。
 *
 * 两段各有各的必要性：realpath 处理 macOS 的 `/tmp` → `/private/tmp` 与 Windows 短名；
 * 规范化处理分隔符与盘符大小写——网关回写给工具的就是规范化后的那个串（ADR-0024 补记），
 * 拿 `join()` 拼出来的原生路径去比，在 Windows 上永远不相等。
 *
 * `rest` 是给"尚不存在的路径"用的：只 realpath 存在的那一段，剩下的原样拼。
 */
const realOf = async (base: string, ...rest: string[]): Promise<string> => {
  let head: string;
  try {
    head = await realNative(base);
  } catch {
    head = resolve(base);
  }
  return normalizedOrThrow(rest.length === 0 ? head : join(head, ...rest));
};
