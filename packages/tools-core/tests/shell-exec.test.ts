import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultBlock } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { AbortLike, ToolContext } from '@xm/kernel';
import { shellExecTool } from '@xm/tools-core';

/**
 * ── `shell.exec` 的进程级约束（ADR-0026 决策五 / docs/09 C2）──
 *
 * C2 定的是"不强制沙箱"。那就必须把"不强制"与"什么都不做"分清楚：下面每一条
 * 都是真的、可测的，而且各自对应一种具体的失控方式。
 *
 * 这些用例跑的是**真实进程**。它们在 Linux CI 上是硬断言；
 * Windows 的进程组语义不同，所以判据写成"能不能观察到这件事"，不写平台分支——
 * 这条纪律是 ADR-0025 大小写那一格的直接沿用：
 * **"我们有三平台 CI"不等于"我们测过那个平台的语义"。**
 */

/**
 * 这一批用例要的是一个 POSIX shell 与 `sleep` / `yes`。
 *
 * **判据写成"能不能观察到这件事"，不写平台分支**（`process.platform` 在本仓库
 * 是被 eslint 禁掉的，ADR-0007）。这条纪律是 ADR-0025 大小写那一格的直接沿用：
 * "我们有三平台 CI" 不等于 "我们测过那个平台的语义"——本地跑的这份用例，
 * 得把它自己的前提也当成断言的一部分。
 */
const posixShell = spawnSync('sh', ['-c', 'exit 0']).status === 0;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xm-shell-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NEVER: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const ctx = (signal: AbortLike = NEVER): ToolContext => ({
  sessionId: newSessionId(),
  signal,
  cwd: dir,
  executor: 'local',
});

/** 跑一次，把结果里的文本拼起来 */
async function run(
  input: Record<string, unknown>,
  options: Partial<Parameters<typeof shellExecTool>[0]> = {},
  signal: AbortLike = NEVER,
): Promise<string> {
  let out = '';
  const tool = shellExecTool({ os: 'linux', ...options });
  for await (const p of tool.execute(input, ctx(signal))) {
    if (p.kind === 'result') {
      out += p.forModel
        .filter((b: ResultBlock): b is Extract<ResultBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }
  }
  return out;
}

describe.skipIf(!posixShell)('跑一条命令', () => {
  it('拿得到 stdout 与退出码', async () => {
    const out = await run({ argv: ['echo', 'hello-xm'] });
    expect(out).toContain('hello-xm');
    expect(out).toContain('退出码 0');
  });

  it('🔴 退出码非零是**事实**，不是异常 —— 模型要靠它判断下一步', async () => {
    const out = await run({ argv: ['sh', '-c', 'echo oops >&2; exit 3'] });
    expect(out).toContain('退出码 3');
    expect(out).toContain('oops');
  });

  it('在指定的 cwd 里跑', async () => {
    await writeFile(join(dir, 'marker.txt'), 'x');
    const out = await run({ argv: ['ls'], cwd: dir });
    expect(out).toContain('marker.txt');
  });

  it('启动不了的命令有明确的说法，不是一句沉默', async () => {
    expect(await run({ argv: [join(dir, 'no-such-binary')] })).toContain('没能启动');
  });
});

describe.skipIf(!posixShell)('🔴 进程级的硬约束', () => {
  it('🔴 env 是白名单 —— 不白名单，一条命令就能读出小明自己的密钥', async () => {
    const out = await run({ argv: ['sh', '-c', 'echo "[$XM_SECRET][$PATH]"'] }, {
      env: { XM_SECRET: 'sk-must-not-leak', PATH: '/usr/bin:/bin:/usr/local/bin' },
    });
    expect(out).not.toContain('sk-must-not-leak');
    // 白名单里的确实传下去了，否则这条用例可能只是因为命令没跑起来
    expect(out).toContain('/bin');
  });

  it('🔴 超时会结束进程，并且说出来', async () => {
    const out = await run({ argv: ['sleep', '5'], timeoutMs: 300 });
    expect(out).toContain('超时');
  }, 10_000);

  it('🔴 按进程组 kill —— 只杀直接子进程的话，孙进程会活下来', async () => {
    /*
     * 子进程再派生一个孙进程，孙进程往文件里追加内容。超时之后如果只杀了子进程，
     * 孙进程会继续写——"点了停止但东西还在跑"比不能停更糟，因为用户以为已经停了。
     */
    const witness = join(dir, 'grandchild.log');
    await run({
      argv: ['sh', '-c', `sh -c 'sleep 0.6; echo alive >> ${witness}' & sleep 5`],
      timeoutMs: 250,
    });
    await new Promise((r) => setTimeout(r, 1200));
    let wrote: boolean;
    try {
      wrote = (await readFile(witness, 'utf8')).includes('alive');
    } catch {
      wrote = false;
    }
    expect(wrote).toBe(false);
  }, 15_000);

  it('🔴 中断当场生效', async () => {
    const listeners: (() => void)[] = [];
    const signal: AbortLike = {
      aborted: false,
      addEventListener: (_t, l) => listeners.push(l),
      removeEventListener: () => undefined,
    };
    const started = Date.now();
    const promise = run({ argv: ['sleep', '5'] }, {}, signal);
    setTimeout(() => {
      for (const l of listeners) l();
    }, 200);
    expect(await promise).toContain('中断');
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  it('🔴 stdin 不继承 —— 继承的话，一条等输入的命令会把整个 Turn 挂住', async () => {
    const out = await run({ argv: ['cat'], timeoutMs: 3000 });
    // 读到 EOF 就正常退出了；挂住的话这条用例会超时
    expect(out).toContain('退出码 0');
  }, 8000);

  it('🔴 输出超上限就停，并且说出来 —— 悄悄截断与悄悄省略是同一类错误', async () => {
    const out = await run({ argv: ['sh', '-c', 'yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'], timeoutMs: 8000 });
    expect(out).toContain('上限');
  }, 15_000);

  it('本轮已被中断时根本不启动进程', async () => {
    const aborted: AbortLike = { ...NEVER, aborted: true };
    expect(await run({ argv: ['echo', 'x'] }, {}, aborted)).toContain('已被中断');
  });
});

describe('工具声明', () => {
  it('声明了 commandInputs —— 不声明的话网关会当场拒绝', () => {
    expect(shellExecTool({ os: 'linux' }).commandInputs).toEqual({ argv: 'argv', cwd: 'cwd' });
  });

  it('入参只收 argv 数组，不收一整条命令串', () => {
    const tool = shellExecTool({ os: 'linux' });
    expect(() => tool.parseInput({ command: 'rm -rf /' })).toThrow();
    expect(() => tool.parseInput({ argv: [] })).toThrow();
  });
});
