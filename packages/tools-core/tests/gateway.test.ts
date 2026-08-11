import { realpath as realpathCb } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

/**
 * 判权用的主 target = **第一条主张**的目标。
 *
 * `ResolvedCall` 上曾经有个 `target` 字段，ADR-0026 把它换成了 `claims`：
 * 一次调用不只作用在一个地方。对路径工具来说两者等价——它的每条主张
 * 共用同一个 target。
 */
const primary = (r: { claims: readonly { target: string }[] }): string => r.claims[0]?.target ?? '';

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
    expect(primary(resolved)).not.toContain('looks-innocent');
    expect(primary(resolved)).toBe(await realOf(join(outside, 'id_rsa')));
  });

  it('穿过符号链接目录的路径同样被解析', async () => {
    await symlink(outside, join(root, 'link-dir'));
    const resolved = await nodeToolGateway().resolve(
      tool(),
      { path: 'link-dir/id_rsa' },
      ctx(root),
    );
    expect(primary(resolved)).toBe(await realOf(join(outside, 'id_rsa')));
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
    expect(evaluate({ request: ask(join(root, 'looks-innocent.txt')), layers }).effect)
      .toBe('allow');
    // 解析之后：命中 deny
    expect(evaluate({ request: ask(join(outside, 'id_rsa')), layers }).effect)
      .toBe('deny');
  });
});

/**
 * ── 大小写：一条 deny 能不能靠改大小写绕过去 ──
 *
 * macOS 与 Windows 的文件系统默认**大小写不敏感**：`~/.SSH/id_rsa` 打开的
 * 就是 `~/.ssh/id_rsa` 那个文件。而规则匹配是字面的——Windows 上靠
 * `pathCaseInsensitive` 打开忽略大小写（services.ts 按 `platform.os` 传），
 * macOS 上**没有**打开它。那 macOS 靠什么？靠 `realpath.native`：
 * 它返回的是磁盘上真实的大小写，于是 `.SSH` 在进判定之前就已经变回 `.ssh`。
 *
 * 这条链路只有一个环节是我不能在本地证明的（这台机器是 Linux，大小写敏感），
 * 而 ADR-0025 的整批 deny 都压在它上面。所以这里不写平台判断，写**文件系统的
 * 事实判断**：如果换个大小写真能打开同一个文件，那这个卷就是大小写不敏感的，
 * 网关就必须把它归回真实大小写。Linux 上前提不成立，用例自己跳过；
 * macOS / Windows 的 CI 上它是硬断言。
 */
describe('🔴 大小写不敏感的卷上，改大小写绕不过规则', () => {
  it('网关把路径归回磁盘上真实的大小写', async () => {
    const shouty = join(root, 'SRC', 'a.ts');
    let caseInsensitive = true;
    try {
      await stat(shouty);
    } catch {
      caseInsensitive = false;
    }
    if (!caseInsensitive) {
      // 这个卷大小写敏感（Linux）：`SRC/a.ts` 是另一个不存在的路径，不存在绕过问题
      expect(await realOf(join(root, 'src', 'a.ts'))).not.toBe(normalizedOrThrow(shouty));
      return;
    }

    const r = await nodeToolGateway().resolve(tool(), { path: 'SRC/a.ts' }, ctx(root));
    expect(primary(r)).toBe(await realOf(join(root, 'src', 'a.ts')));
  });
});

describe('解析规则', () => {
  it('相对路径按会话的 cwd 绝对化', async () => {
    const r = await nodeToolGateway().resolve(tool(), { path: 'src/a.ts' }, ctx(root));
    expect(primary(r)).toBe(await realOf(join(root, 'src', 'a.ts')));
  });

  it('.. 被消解', async () => {
    const r = await nodeToolGateway().resolve(tool(), { path: 'src/../src/a.ts' }, ctx(root));
    expect(primary(r)).toBe(await realOf(join(root, 'src', 'a.ts')));
  });

  it('🔴 还不存在的文件也能解析 —— 否则 fs.write 永远新建不了文件', async () => {
    const r = await nodeToolGateway().resolve(tool(), { path: 'src/new/deep/x.md' }, ctx(root));
    expect(primary(r)).toBe(await realOf(join(root, 'src'), 'new', 'deep', 'x.md'));
  });

  it('🔴 不存在的文件穿过符号链接目录时，链接那一段仍然被解析', async () => {
    // 这一条是"取最深的存在祖先"真正要保证的东西：
    // 逃逸的载体是**已经存在**的那一段，剩下的段按定义没有链接可解
    const r = await nodeToolGateway().resolve(tool(), { path: 'link-dir/brand-new.txt' }, ctx(root));
    expect(primary(r)).toBe(await realOf(outside, 'brand-new.txt'));
  });

  it('🔴 入参被回写 —— 判定与执行用的是同一个字符串', async () => {
    const r = await nodeToolGateway().resolve(tool(), { path: 'src/a.ts', other: 'x' }, ctx(root));
    expect((r.input as { path: string }).path).toBe(primary(r));
    // 非路径字段原样保留
    expect((r.input as { other: string }).other).toBe('x');
  });

  it('pathInputs 的第一个字段是判权 target', async () => {
    const t = tool({
      inputSchema: z.strictObject({ src: z.string(), dst: z.string() }),
      pathInputs: ['dst', 'src'],
    });
    const r = await nodeToolGateway().resolve(t, { src: 'src/a.ts', dst: 'out.txt' }, ctx(root));
    expect(primary(r)).toBe(await realOf(root, 'out.txt'));
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
    expect(primary(r)).toBe('');
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

/**
 * ── 命令分支（ADR-0026）──
 *
 * 网关在这里做的事与路径分支是同一件：把内核拆出来的主张里那些**还是原始串**的路径
 * 展开 `~`、绝对化、realpath。用的是同一个 `resolveDeep` / `canonical`——
 * 一个文件无论来自 `fs.read {path}` 还是 `rm <path>`，解析它的代码只有一份。
 */
describe('命令分支', () => {
  const shell = (over: Partial<Parameters<typeof defineTool>[0]> = {}): RegisteredTool =>
    defineTool({
      name: 'shell.probe',
      group: 'shell',
      description: '探针',
      inputSchema: z.strictObject({ argv: z.array(z.string()), cwd: z.string().optional() }),
      risk: 'medium',
      capabilities: ['shell.exec'],
      commandInputs: { argv: 'argv', cwd: 'cwd' },
      // eslint-disable-next-line @typescript-eslint/require-await
      async *execute() {
        yield { kind: 'result' as const, forModel: [] };
      },
      ...over,
    });

  const claimsOf = async (argv: string[], home?: string) =>
    (
      await nodeToolGateway(home === undefined ? {} : { home }).resolve(
        shell(),
        { argv },
        ctx(root),
      )
    ).claims;

  it('🔴 相对路径的操作数按 cwd 绝对化', async () => {
    const claims = await claimsOf(['rm', 'src/a.ts']);
    expect(claims).toContainEqual({
      capability: 'fs.delete',
      target: await realOf(join(root, 'src', 'a.ts')),
    });
  });

  it('🔴 符号链接照样解开 —— 与路径工具走的是同一段代码', async () => {
    const link = join(root, 'link-to-secret');
    await symlink(join(outside, 'id_rsa'), link).catch(() => undefined);
    const claims = await claimsOf(['cat', 'link-to-secret']);
    expect(claims).toContainEqual({
      capability: 'fs.read',
      target: await realOf(join(outside, 'id_rsa')),
    });
  });

  it('🔴 词首的 ~ 按家目录展开 —— DoD 的 `rm -rf ~` 全靠这一步', async () => {
    const claims = await claimsOf(['rm', '-rf', '~'], outside);
    expect(claims).toContainEqual({ capability: 'fs.delete', target: await realOf(outside) });
  });

  it('~ 也回写进 argv —— 没有 shell 参与，不回写的话执行的是一个叫 `~` 的文件', async () => {
    const r = await nodeToolGateway({ home: outside }).resolve(
      shell(),
      { argv: ['rm', '-rf', '~/x'] },
      ctx(root),
    );
    expect((r.input as { argv: string[] }).argv[2]).toBe(join(outside, 'x'));
  });

  it('段中间的 ~ 不动 —— 那是合法文件名', async () => {
    /*
     * 不能用 `a~1.txt`：它同时是 emacs 备份文件的形状，**也**是 Windows 8.3 短名
     * 的形状（ADR-0018 的 SHORT_NAME_8_3：`[^/]{1,6}~\d{1,3}(\.ext)?`）。
     * 在 Windows CI 上会被后者的失败关闭规则拒绝——那条规则管的是完全不同的一件事，
     * 这里选一个 `~` 后面不是纯数字的文件名，避开两个检查的交集。
     */
    const claims = await claimsOf(['rm', 'note~backup.txt'], outside);
    expect(claims).toContainEqual({
      capability: 'fs.delete',
      target: await realOf(join(root, 'note~backup.txt')),
    });
  });

  it('命令类主张的 target 是规范形式', async () => {
    const claims = await claimsOf(['/bin/echo', 'hi']);
    expect(claims).toContainEqual({ capability: 'shell.exec', target: 'echo hi' });
  });

  it('🔴 声明了命令类能力却没有 commandInputs → 拒绝，不放行', async () => {
    const naked = defineTool({
      name: 'shell.naked',
      group: 'shell',
      description: '忘了声明',
      inputSchema: z.strictObject({ argv: z.array(z.string()) }),
      risk: 'medium',
      capabilities: ['shell.exec'],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *execute() {
        yield { kind: 'result' as const, forModel: [] };
      },
    });
    await expect(
      nodeToolGateway().resolve(naked, { argv: ['ls'] }, ctx(root)),
    ).rejects.toThrow(/commandInputs/);
  });

  it('argv 不是字符串数组 → 拒绝', async () => {
    await expect(
      nodeToolGateway().resolve(shell(), { argv: 'rm -rf /' }, ctx(root)),
    ).rejects.toThrow(/字符串数组/);
  });

  it('判不了的命令 → 拒绝，且理由是"判不了"', async () => {
    await expect(
      nodeToolGateway().resolve(shell(), { argv: ['sh', '-c', 'rm $(cat x)'] }, ctx(root)),
    ).rejects.toThrow(/命令替换|变量替换/);
  });

  it('cwd 入参会被 realpath 并回写', async () => {
    const r = await nodeToolGateway().resolve(shell(), { argv: ['ls'], cwd: 'src' }, ctx(root));
    expect((r.input as { cwd: string }).cwd).toBe(await realOf(join(root, 'src')));
  });
});

/**
 * ── 网络分支（M1-d，IP 级 SSRF 判定）──
 *
 * 与命令分支同一个测试哲学：不发真实网络请求，用注入的 `dnsLookup` 桩模拟解析结果。
 * 这里最要紧的断言是"DNS 只解析一次"——防 rebinding 的全部论证都建立在这一点上，
 * 光测"私网地址被拦"测不出"工具会不会自己再解析一次"这件事。
 */
describe('网络分支', () => {
  const fetcher = (over: Partial<Parameters<typeof defineTool>[0]> = {}): RegisteredTool =>
    defineTool({
      name: 'web.probe',
      group: 'web',
      description: '探针',
      inputSchema: z.strictObject({ url: z.string() }),
      risk: 'medium',
      capabilities: ['net.fetch'],
      hostInputs: ['url'],
      // eslint-disable-next-line @typescript-eslint/require-await
      async *execute() {
        yield { kind: 'result' as const, forModel: [] };
      },
      ...over,
    });

  const stubLookup = (
    addresses: readonly { address: string; family: 4 | 6 }[],
  ): { calls: string[]; dnsLookup: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]> } => {
    const calls: string[] = [];
    return {
      calls,
      dnsLookup: (hostname: string) => {
        calls.push(hostname);
        return Promise.resolve(addresses);
      },
    };
  };

  it('🔴 声明了网络类能力却没有 hostInputs → 拒绝，不放行', async () => {
    const t = fetcher({ hostInputs: [] });
    await expect(
      nodeToolGateway().resolve(t, { url: 'https://example.com/' }, ctx(root)),
    ).rejects.toThrow(/hostInputs/);
  });

  it('DNS 解析失败 → 拒绝，不问、不发权限事件', async () => {
    const dnsLookup = () => Promise.reject(new Error('ENOTFOUND'));
    await expect(
      nodeToolGateway({ dnsLookup }).resolve(fetcher(), { url: 'https://example.com/' }, ctx(root)),
    ).rejects.toThrow(GatewayError);
  });

  it('解析成功：产出两条 claim（域名 + 解析出的 IP），并把地址写进 pinnedHosts', async () => {
    const { calls, dnsLookup } = stubLookup([{ address: '169.254.169.254', family: 4 }]);
    const r = await nodeToolGateway({ dnsLookup }).resolve(
      fetcher(),
      { url: 'https://example.com/meta' },
      ctx(root),
    );

    expect(calls).toEqual(['example.com']); // 🔴 只解析一次
    expect(r.claims).toContainEqual({ capability: 'net.fetch', target: 'https://example.com/meta' });
    // claim B 是解析出的 IP：只用来给 SSRF 的 IP 段规则匹配（ADR-0028）
    expect(r.claims).toContainEqual({
      capability: 'net.fetch',
      target: 'https://169.254.169.254/',
    });
    expect(r.pinnedHosts?.get('example.com')).toEqual({ address: '169.254.169.254', family: 4 });
  });

  it('端口保留在解析出的 IP claim 里', async () => {
    const { dnsLookup } = stubLookup([{ address: '10.0.0.5', family: 4 }]);
    const r = await nodeToolGateway({ dnsLookup }).resolve(
      fetcher(),
      { url: 'https://internal.example:8443/api' },
      ctx(root),
    );
    expect(r.claims).toContainEqual({
      capability: 'net.fetch',
      target: 'https://10.0.0.5:8443/',
    });
  });

  it('IPv6 地址在 claim 里带方括号', async () => {
    const { dnsLookup } = stubLookup([{ address: '::1', family: 6 }]);
    const r = await nodeToolGateway({ dnsLookup }).resolve(
      fetcher(),
      { url: 'http://example.com/' },
      ctx(root),
    );
    expect(r.claims).toContainEqual({
      capability: 'net.fetch',
      target: 'http://[::1]/',
    });
    expect(r.pinnedHosts?.get('example.com')).toEqual({ address: '::1', family: 6 });
  });

  it('归一失败（非 http(s)）：不抛错，产出一条带原始字符串的 claim 交给策略引擎失败关闭', async () => {
    const dnsLookup = (): Promise<never> => {
      throw new Error('不应该被调用——归一都没过，不该走到 DNS 这一步');
    };
    const r = await nodeToolGateway({ dnsLookup }).resolve(
      fetcher(),
      { url: 'file:///etc/passwd' },
      ctx(root),
    );
    expect(r.claims).toEqual([{ capability: 'net.fetch', target: 'file:///etc/passwd' }]);
    expect(r.pinnedHosts?.size ?? 0).toBe(0);
  });

  it('URL 字段不是字符串 → 拒绝', async () => {
    await expect(
      nodeToolGateway().resolve(fetcher(), { url: 42 }, ctx(root)),
    ).rejects.toThrow(/URL 字符串/);
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
