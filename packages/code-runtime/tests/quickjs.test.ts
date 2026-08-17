import { afterAll, describe, expect, it } from 'vitest';
import type { CodeBindingResult, CodeRuntimeInput } from '@xm/kernel';
import { createQuickJsCodeRuntime } from '@xm/code-runtime';

/**
 * QuickJS 提供者的行为验收（ADR-0069）。
 *
 * 隔离本身的断言在 `isolation.test.ts`；这里管的是"它作为一个 `CodeRuntime` 端口的
 * 实现是不是守约"：只报告失败不抛失败、预算真的兜得住、绑定是同步形态、
 * `Date` 与 `Math.random` 确实被换成了宿主的投影。
 */

const runtime = createQuickJsCodeRuntime({
  budget: { wallClockMs: 6_000, cpuMs: 1_500, memoryBytes: 16 * 1024 * 1024 },
});
afterAll(async () => {
  await runtime.dispose();
});

const NEVER_ABORTS = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const run = (
  source: string,
  options: {
    readonly call?: (name: string, input: unknown) => CodeBindingResult;
    readonly bindings?: readonly string[];
    readonly signal?: CodeRuntimeInput['signal'];
  } = {},
) =>
  runtime.run({
    source,
    bindings: options.bindings ?? [],
    call: (request) =>
      Promise.resolve(
        options.call?.(request.name, request.input) ?? { ok: false, message: '没有这个绑定。' },
      ),
    nowMs: 1_700_000_000_000,
    randomSeed: 'seed-固定',
    signal: options.signal ?? NEVER_ABORTS,
  });

describe('QuickJS 提供者 · 基本形态', () => {
  it('程序用 return 交回结果，TypeScript 类型标注被剥掉', async () => {
    const result = await run(`const n: number = 20; return { total: n + 2 };`);
    expect(result).toMatchObject({ ok: true, value: { total: 22 }, clipped: false });
  });

  it('console.log 进 logs，不进返回值', async () => {
    const result = await run(`console.log('一', { b: 2 }); return 'done';`);
    expect(result.logs).toEqual(['一 {"b":2}']);
    expect(result.value).toBe('done');
  });

  it('程序抛异常是 error 而不是 reject —— 运行时只报告失败', async () => {
    const result = await run(`throw new Error('模型写错了');`);
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ kind: 'throw', message: '模型写错了' });
  });

  it('语法错在剥类型这一步就被认出来，分类是 compile', async () => {
    const result = await run(`const = ;`);
    expect(result.error?.kind).toBe('compile');
  });

  it('程序没 return 时 value 缺席，而不是 null', async () => {
    const result = await run(`const x = 1;`);
    expect(result.ok).toBe(true);
    expect('value' in result).toBe(false);
  });
});

describe('QuickJS 提供者 · 绑定', () => {
  it('绑定按点号装成嵌套命名空间，签名是同步的', async () => {
    const seen: string[] = [];
    const result = await run(
      `const a = xm.fs.read({ path: '/a' });
       const b = xm.shell.exec({ argv: ['ls'] });
       return a.text + '|' + b.text;`,
      {
        bindings: ['fs.read', 'shell.exec'],
        call: (name) => {
          seen.push(name);
          return { ok: true, value: { text: name.toUpperCase() } };
        },
      },
    );
    expect(result.value).toBe('FS.READ|SHELL.EXEC');
    expect(seen).toEqual(['fs.read', 'shell.exec']);
  });

  it('🔴 被拒的子调用在程序里是可 catch 的异常，理由原样带过去', async () => {
    const result = await run(
      `try { xm.fs.write({ path: '/etc/x' }); return 'never'; }
       catch (e) { return { message: e.message, code: e.code }; }`,
      {
        bindings: ['fs.write'],
        call: () => ({ ok: false, message: '红线：不允许写 /etc。', code: 'policy_denied' }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ message: '红线：不允许写 /etc。', code: 'policy_denied' });
  });

  it('连调五十次不失稳——Code Mode 的收益全建立在这上面', async () => {
    let calls = 0;
    const result = await run(
      `let out = ''; for (let i = 0; i < 50; i++) { out = xm.t.echo({ i: i }); } return out;`,
      {
        bindings: ['t.echo'],
        call: (_name, input) => {
          calls += 1;
          return { ok: true, value: `#${String((input as { i: number }).i)}` };
        },
      },
    );
    expect(calls).toBe(50);
    expect(result.value).toBe('#49');
  });

  it('程序 catch 掉之后还能接着调下一个工具', async () => {
    const seen: string[] = [];
    const result = await run(
      `try { xm.a.one({}); } catch (e) {}
       return xm.b.two({});`,
      {
        bindings: ['a.one', 'b.two'],
        call: (name) => {
          seen.push(name);
          return name === 'a.one' ? { ok: false, message: '拒绝' } : { ok: true, value: 'ok' };
        },
      },
    );
    expect(seen).toEqual(['a.one', 'b.two']);
    expect(result.value).toBe('ok');
  });
});

describe('QuickJS 提供者 · 确定性投影（ADR-0069 §三.1）', () => {
  it('Date 全程返回宿主给的那一刻，Math.random 由种子决定', async () => {
    const first = await run(`return { t: Date.now(), d: new Date().getTime(), r: Math.random() };`);
    const second = await run(`return { t: Date.now(), d: new Date().getTime(), r: Math.random() };`);
    expect(first.value).toEqual(second.value);
    expect((first.value as { t: number }).t).toBe(1_700_000_000_000);
    expect((first.value as { d: number }).d).toBe(1_700_000_000_000);
  });

  it('同一段程序里时间不流逝', async () => {
    const result = await run(
      `const a = Date.now(); let s = 0; for (let i = 0; i < 200000; i++) s += i; return Date.now() - a;`,
    );
    expect(result.value).toBe(0);
  });
});

describe('QuickJS 提供者 · 预算', () => {
  it('死循环撞 CPU 预算，分类是 cpu，宿主随后照常可用', async () => {
    const result = await run(`while (true) { }`);
    expect(result.error?.kind).toBe('cpu');
    expect((await run(`return 1 + 1;`)).value).toBe(2);
  });

  it('要一大块内存撞上限，分类是 memory', async () => {
    const result = await run(`const a = new Array(20000000).fill(1); return a.length;`);
    expect(result.error?.kind).toBe('memory');
  });

  /**
   * 🔴 **墙钟不是可选的**（ADR-0069 §三.3）。
   *
   * 一次永不返回的绑定调用会让客体域停在 asyncify 的挂起点上：**没有字节码在跑**，
   * interrupt handler 一次也不会再被问到，`evalCodeAsync` 那个 promise 也永远不 settle。
   * CPU 预算给到一分钟都救不了它，只有宿主侧的墙钟能。
   *
   * 反向演练：把 `wallClockMs` 调大到 60 秒（等于"只留 CPU 预算"），这条用例会挂到超时。
   */
  it('🔴 绑定永不返回：CPU 预算一次都不触发，靠墙钟判失败', async () => {
    const short = createQuickJsCodeRuntime({ budget: { wallClockMs: 700, cpuMs: 60_000 } });
    try {
      const result = await short.run({
        source: `xm.hang.forever({}); return 'unreachable';`,
        bindings: ['hang.forever'],
        call: () => new Promise<never>(() => undefined),
        nowMs: 1,
        randomSeed: 's',
        signal: NEVER_ABORTS,
      });
      expect(result.error?.kind).toBe('timeout');
    } finally {
      await short.dispose();
    }
  });

  /**
   * 🔴 **宿主侧的活也得停**（地基复审四 C2）。
   *
   * `terminate()` 只杀客体域。已经派发出去的绑定调用是宿主上的普通 Promise——
   * 没有这个信号，一次被墙钟掐掉的程序留下的 `shell.exec` 会一直跑到自己结束，
   * 而调用方早就拿到 `timeout` 了。
   */
  it('🔴 超时/取消时，宿主侧那次绑定调用收到取消信号', async () => {
    const short = createQuickJsCodeRuntime({ budget: { wallClockMs: 500, cpuMs: 60_000 } });
    let seen: CodeRuntimeInput['signal'] | undefined;
    let abortedDuringCall = false;
    try {
      const result = await short.run({
        source: `xm.hang.forever({}); return 'unreachable';`,
        bindings: ['hang.forever'],
        call: (_request, signal) => {
          seen = signal;
          signal.addEventListener('abort', () => {
            abortedDuringCall = true;
          });
          return new Promise<never>(() => undefined);
        },
        nowMs: 1,
        randomSeed: 's',
        signal: NEVER_ABORTS,
      });
      expect(result.error?.kind).toBe('timeout');
      expect(seen?.aborted).toBe(true);
      // 不只是"事后看它是 aborted"——监听器真的被触发过，工具因此能当场收手
      expect(abortedDuringCall).toBe(true);
    } finally {
      await short.dispose();
    }
  });

  it('这一轮被中断：程序当场停下，分类是 aborted', async () => {
    const listeners: (() => void)[] = [];
    const signal = {
      aborted: false,
      addEventListener: (_type: 'abort', listener: () => void) => listeners.push(listener),
      removeEventListener: () => undefined,
    };
    const pending = runtime.run({
      source: `xm.hang.forever({}); return 'unreachable';`,
      bindings: ['hang.forever'],
      call: () => new Promise<never>(() => undefined),
      nowMs: 1,
      randomSeed: 's',
      signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const listener of listeners) listener();
    expect((await pending).error?.kind).toBe('aborted');
  });

  it('日志与返回值都有上限，超出即 clipped', async () => {
    const small = createQuickJsCodeRuntime({ budget: { maxLogs: 2, maxValueChars: 20 } });
    try {
      const result = await small.run({
        source: `for (let i = 0; i < 9; i++) console.log('行' + i); return 'x'.repeat(500);`,
        bindings: [],
        call: () => Promise.resolve({ ok: false }),
        nowMs: 1,
        randomSeed: 's',
        signal: NEVER_ABORTS,
      });
      expect(result.logs).toHaveLength(2);
      expect(result.clipped).toBe(true);
    } finally {
      await small.dispose();
    }
  });
});
