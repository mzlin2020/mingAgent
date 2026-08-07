import { describe, expect, it } from 'vitest';
import type { Capability } from '@xm/contracts';
import { ALL_CAPABILITIES } from '@xm/contracts';
import type { CommandClaim } from '@xm/kernel';
import { DENIED_COMMAND_BINS, analyzeArgv } from '@xm/kernel';

/**
 * ── 一条命令 → 一组能力主张（ADR-0026）──
 *
 * 这里钉住的核心只有一句：**`rm -rf ~` 之所以被拦，是因为它产出了一条
 * `fs.delete <家目录>` 的主张**，而不是因为有谁写了一条匹配 "rm -rf ~" 的规则。
 * 后者挡不住任何一种等价写法，前者撞的是一条 M0 就写好的红线。
 *
 * 另外三件必须钉死的：
 *   · 这张表**只能加主张不能减**——漏一条表项 = 退回 `def.shell-exec` 的 ask，不是放行
 *   · `sh -c` / `env` 这类包一层的写法要递归，否则包一层就绕过去了
 *   · `curl` 要产出 `net.fetch`，否则"用 shell 跑 curl"是整套注入降级的绕过口
 */

const analyze = (argv: readonly string[]) => {
  const r = analyzeArgv(argv);
  if (!r.ok) throw new Error(`本该分析得开：${argv.join(' ')} —— ${r.reason}`);
  return r;
};

/** 某条主张在不在里面。路径主张比的是**原始串**，展开与 realpath 是网关的事 */
const has = (claims: readonly CommandClaim[], capability: Capability, target: string): boolean =>
  claims.some(
    (c) =>
      c.capability === capability &&
      (c.target.kind === 'path' ? c.target.raw : c.target.value) === target,
  );

const capsOf = (claims: readonly CommandClaim[]): Capability[] => [
  ...new Set(claims.map((c) => c.capability)),
];

describe('🔴 DoD：rm 的四种写法拆出同一条 fs.delete 主张', () => {
  it.each([
    ['朴素', ['rm', '-rf', '/']],
    ['双空格（argv 里体现为参数本来就是分开的）', ['rm', '-rf', '', '/']],
    ['绝对路径的 bin', ['/bin/rm', '-rf', '/']],
    ['sh -c 包一层', ['sh', '-c', 'rm -rf /']],
    ['bash -c 包一层', ['bash', '-c', 'rm -rf /']],
    ['env 包一层', ['env', 'FOO=1', 'rm', '-rf', '/']],
    ['timeout 包一层', ['timeout', '5', 'rm', '-rf', '/']],
    ['sh -c 里再包一层 env', ['sh', '-c', 'env FOO=1 rm -rf /']],
  ])('%s', (_label, argv) => {
    expect(has(analyze(argv).claims, 'fs.delete', '/')).toBe(true);
  });

  it('🔴 家目录：判定拿到的是原始的 `~`，由网关展开（内核没有文件系统）', () => {
    expect(has(analyze(['rm', '-rf', '~']).claims, 'fs.delete', '~')).toBe(true);
  });
});

describe('🔴 主张只能加，不能减', () => {
  it('表里没有的 bin：只剩 shell.exec 一条 —— 退回 def.shell-exec 的 ask，不是放行', () => {
    const { claims } = analyze(['my-own-binary', '--flag', 'x']);
    expect(capsOf(claims)).toEqual(['shell.exec']);
  });

  it('任何命令都至少产出 shell.exec —— 工具静态声明的能力不会被这张表吃掉', () => {
    const commands = [
      ['ls'],
      ['rm', '-rf', '/tmp/x'],
      ['git', 'push'],
      ['curl', 'https://example.com/a'],
      ['sudo', 'ls'],
      ['npm', 'install', 'x'],
      ['sh', '-c', 'echo hi'],
    ];
    for (const argv of commands) {
      expect(capsOf(analyze(argv).claims)).toContain('shell.exec');
    }
  });

  it('产出的能力全都在闭集里', () => {
    const { claims } = analyze(['sh', '-c', 'curl https://x.com/a > out.txt']);
    for (const c of claims) expect(ALL_CAPABILITIES).toContain(c.capability);
  });
});

describe('文件类命令', () => {
  it.each([
    ['rm 的每个操作数都是一次删除', ['rm', 'a', 'b'], 'fs.delete', ['a', 'b']],
    ['cat 是读', ['cat', '/etc/hosts'], 'fs.read', ['/etc/hosts']],
    ['ls 也是读 —— 列目录同样受 ADR-0025 那批 deny 管', ['ls', '~/.ssh'], 'fs.read', ['~/.ssh']],
    ['tee 是写', ['tee', 'out.txt'], 'fs.write', ['out.txt']],
    ['mkdir 是写', ['mkdir', '-p', 'a/b'], 'fs.write', ['a/b']],
  ])('%s', (_label, argv, capability, targets) => {
    const { claims } = analyze(argv);
    for (const t of targets) expect(has(claims, capability as Capability, t)).toBe(true);
  });

  it('cp：来源读、目的地写', () => {
    const { claims } = analyze(['cp', 'a', 'b', 'dir']);
    expect(has(claims, 'fs.read', 'a')).toBe(true);
    expect(has(claims, 'fs.read', 'b')).toBe(true);
    expect(has(claims, 'fs.write', 'dir')).toBe(true);
    expect(has(claims, 'fs.write', 'a')).toBe(false);
  });

  it('🔴 mv：来源同时是一次删除 —— 移走和删掉对来源来说是同一件事', () => {
    const { claims } = analyze(['mv', 'a', 'b']);
    expect(has(claims, 'fs.delete', 'a')).toBe(true);
    expect(has(claims, 'fs.write', 'b')).toBe(true);
  });

  it('chmod 的第一个操作数是模式，不是路径', () => {
    const { claims } = analyze(['chmod', '755', 'x.sh']);
    expect(has(claims, 'fs.write', 'x.sh')).toBe(true);
    expect(has(claims, 'fs.write', '755')).toBe(false);
  });

  it('选项不会被当成路径', () => {
    const { claims } = analyze(['rm', '-rf', '--verbose', 'x']);
    expect(claims.filter((c) => c.capability === 'fs.delete')).toHaveLength(1);
  });

  it('`--` 之后即使长得像选项也是操作数', () => {
    expect(has(analyze(['rm', '--', '-rf']).claims, 'fs.delete', '-rf')).toBe(true);
  });

  it('🔴 重定向就是一次写 —— `sh -c "x > ~/.bashrc"` 不能只算作执行', () => {
    const { claims } = analyze(['sh', '-c', 'echo evil > ~/.bashrc']);
    expect(has(claims, 'fs.write', '~/.bashrc')).toBe(true);
  });

  it('输入重定向是一次读', () => {
    expect(has(analyze(['sh', '-c', 'wc -l < ~/.ssh/id_rsa']).claims, 'fs.read', '~/.ssh/id_rsa')).toBe(true);
  });

  it('管道每一段都各自拆', () => {
    const { claims } = analyze(['sh', '-c', 'cat a.txt | tee b.txt']);
    expect(has(claims, 'fs.read', 'a.txt')).toBe(true);
    expect(has(claims, 'fs.write', 'b.txt')).toBe(true);
  });
});

describe('🔴 网络：shell 跑 curl 不能绕过不可信标记', () => {
  it('curl 产出 net.fetch，目标是那个 URL', () => {
    const { claims } = analyze(['curl', '-s', 'https://example.com/a']);
    expect(has(claims, 'net.fetch', 'https://example.com/a')).toBe(true);
  });

  it('落盘的那个文件也算一次写', () => {
    const { claims } = analyze(['curl', '-o', 'out.txt', 'https://example.com/a']);
    expect(has(claims, 'fs.write', 'out.txt')).toBe(true);
  });

  it('判不出目的地就明确地判不出来 —— 这是调用没写清楚，不是策略拒绝', () => {
    const r = analyzeArgv(['curl', '-K', 'config']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('URL');
  });
});

describe('包管理与 git', () => {
  it('装包产出 package.install', () => {
    expect(capsOf(analyze(['pnpm', 'add', 'left-pad']).claims)).toContain('package.install');
    expect(capsOf(analyze(['npm', 'install']).claims)).toContain('package.install');
  });

  it('只是跑脚本不算装包', () => {
    expect(capsOf(analyze(['pnpm', 'test']).claims)).not.toContain('package.install');
  });

  it('git push 与 git commit 是两种能力', () => {
    expect(capsOf(analyze(['git', 'push', 'origin', 'main']).claims)).toContain('git.push');
    expect(capsOf(analyze(['git', 'commit', '-m', 'x']).claims)).toContain('git.write');
    expect(capsOf(analyze(['git', 'status']).claims)).toEqual(['shell.exec']);
  });
});

describe('🔴 判不了的那几个 bin', () => {
  it('sudo 产出一条以自己为目标的 shell.exec 主张，供 deny 规则接住', () => {
    expect(has(analyze(['sudo', 'rm', '-rf', '/']).claims, 'shell.exec', 'sudo rm -rf /')).toBe(true);
  });

  it('🔴 包一层 env 也躲不掉 —— 它的主张按**自己那一层**的规范形式产出', () => {
    const { claims } = analyze(['env', 'FOO=1', 'sudo', 'rm', '-rf', '/']);
    expect(has(claims, 'shell.exec', 'sudo rm -rf /')).toBe(true);
  });

  it('sh -c 里的 sudo 同样露头', () => {
    expect(has(analyze(['sh', '-c', 'sudo rm -rf /']).claims, 'shell.exec', 'sudo rm -rf /')).toBe(true);
  });

  it('名单不是空的，且 defaults.ts 用的就是这一份', () => {
    expect(DENIED_COMMAND_BINS).toContain('sudo');
    expect(DENIED_COMMAND_BINS).toContain('xargs');
    expect(DENIED_COMMAND_BINS).toContain('dd');
  });
});

describe('拒绝与边界', () => {
  it('内层 shell 源码判不了时，整条命令判不了', () => {
    const r = analyzeArgv(['sh', '-c', 'rm -rf $(cat target)']);
    expect(r.ok).toBe(false);
  });

  it('argv 里的通配符是**字面量**，不是通配符 —— 没有 shell 参与就没有展开', () => {
    // 这条与上一条不矛盾：`sh -c "rm *"` 里的 * 会被 shell 展开，argv 里的不会
    const r = analyzeArgv(['rm', '*.log']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(has(r.claims, 'fs.delete', '*.log')).toBe(true);
  });

  it('空 argv', () => {
    expect(analyzeArgv([]).ok).toBe(false);
  });

  it('嵌套过深会停下来，而不是转圈', () => {
    const argv = Array.from({ length: 40 }, () => 'env').concat(['rm', '-rf', '/']);
    expect(analyzeArgv(argv).ok).toBe(false);
  });

  it('bash 跑脚本文件：至少认出它要读那个脚本（内容判不了，ADR-0026 遗留）', () => {
    expect(has(analyze(['bash', './build.sh']).claims, 'fs.read', './build.sh')).toBe(true);
  });

  it('同一个 (能力, 目标) 只出现一次 —— 否则同一个确认框要点两遍', () => {
    const { claims } = analyze(['rm', 'a', 'a']);
    expect(claims.filter((c) => c.capability === 'fs.delete')).toHaveLength(1);
  });
});
