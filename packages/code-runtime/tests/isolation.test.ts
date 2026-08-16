import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import * as releaseAsyncify from '@jitl/quickjs-wasmfile-release-asyncify';
import { newQuickJSAsyncWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { createQuickJsCodeRuntime } from '@xm/code-runtime';

/** 见 `code-worker.ts` 里同一处说明：变体包的类型声明只有 CJS 一份 */
const variant = releaseAsyncify.default as unknown as Parameters<
  typeof newQuickJSAsyncWASMModuleFromVariant
>[0];

/**
 * 隔离机制的验收（[ADR-0069](../../../docs/adr/0069-CodeMode的隔离机制.md)）。
 *
 * ADR-0061 §一 承诺"程序拿不到 `node:fs` / `child_process` / `net`"。H2 定案那一批
 * 已经在 `evals/spikes/` 里把它验过一次，那时验的是**机制**（裸的 QuickJS API）；
 * 本文件验的是**产品**——同样几条探针，跑在真正装配起来的 `CodeRuntime` 提供者上。
 * 中间隔着一个 worker、一层协议、一份 prelude，每一层都可能把承诺弄丢。
 * 那份 spike 随本文件退役（M3-h 的落点，见它当时的文件头）。
 *
 * 两条纪律照旧：
 *   · 全局面按"**允许存在什么**"钉死，不按"不允许存在什么"——后者会漏，
 *     因为写清单的人想不到 `std`。
 *   · 朴素 Node worker 的反向演练必须留着。没有它，"全部拿不到"只是一句
 *     无法证伪的断言，正是本仓库栽过八次的形状。
 */

const runtime = createQuickJsCodeRuntime({ budget: { wallClockMs: 8_000 } });
afterAll(async () => {
  await runtime.dispose();
});

const NEVER_ABORTS = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const inGuest = async (source: string): Promise<unknown> => {
  const result = await runtime.run({
    source,
    bindings: ['fs.read'],
    call: () => Promise.resolve({ ok: true, value: {} }),
    nowMs: 1_700_000_000_000,
    randomSeed: 'seed',
    signal: NEVER_ABORTS,
  });
  if (!result.ok) throw new Error(`程序没跑通：${result.error?.message ?? '未知'}`);
  return result.value;
};

/**
 * 四条穿透探针，**两个世界共用同一段源码**。
 *
 * 共用是关键：两边各写各的代码时，"一边红一边绿"可能只是两段代码不一样，
 * 而不是两个隔离机制不一样。
 */
const PROBE = `
  var verdict = {};
  try {
    var fs = require('node:fs');
    verdict.require = typeof fs.readFileSync === 'function' ? '拿到了' : '拿到了但形状不对';
  } catch (e) { verdict.require = '拿不到'; }
  verdict.process = typeof process === 'undefined' ? '拿不到' : '拿到了';
  verdict.fetch = typeof fetch === 'undefined' ? '拿不到' : '拿到了';
  try { Function('return process')(); verdict.functionCtor = '拿到了'; }
  catch (e) { verdict.functionCtor = '拿不到'; }
  return verdict;
`;

/** 朴素 Node worker —— **这就是 ADR-0061 初稿假设的那个东西** */
const inNaiveWorker = (source: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort } = require('node:worker_threads');\n` +
        `parentPort.postMessage((function () {${source}})());`,
      { eval: true },
    );
    worker.once('message', (message: unknown) => {
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', reject);
  });

describe('客体域拿不到宿主能力', () => {
  it('四条穿透探针经 CodeRuntime 提供者跑，全部拿不到', async () => {
    expect(await inGuest(PROBE)).toEqual({
      require: '拿不到',
      process: '拿不到',
      fetch: '拿不到',
      functionCtor: '拿不到',
    });
  });

  it('🔴 反向演练：同一段探针在朴素 Node worker 里全部穿透', async () => {
    expect(await inNaiveWorker(PROBE)).toEqual({
      require: '拿到了',
      process: '拿到了',
      fetch: '拿到了',
      functionCtor: '拿到了',
    });
  });

  it('程序里写 import 编不过——客体域没有模块加载器', async () => {
    const result = await runtime.run({
      source: `import { readFileSync } from 'node:fs'; return 1;`,
      bindings: [],
      call: () => Promise.resolve({ ok: false }),
      nowMs: 1,
      randomSeed: 's',
      signal: NEVER_ABORTS,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('compile');
  });

  /**
   * 动态 `import()` 被客体域拒绝——**这一条只能在机制层验**。
   *
   * 程序是同步函数体（ADR-0069 §三.2），微任务在它返回之后才跑，所以从程序内部
   * 根本观察不到 `import()` 的结果：写成"跑一段程序看它拿到什么"的用例，
   * 无论 import 成没成都是同一个答案，那正是不可证伪的形状。
   *
   * 于是这里直接问客体域本身。它是本包自己的依赖，不是绕过什么——绕过的话，
   * 这条断言就会随着"程序将来能不能 await"一起消失，而模块加载器在不在是与那件事
   * 无关的事实。
   */
  it('动态 import 在客体域里被拒绝', async () => {
    const ctx = (await newQuickJSAsyncWASMModuleFromVariant(variant)).newContext();
    try {
      const evaluated = ctx.evalCode(
        `import('node:child_process').then(function () { return '装上了' },
                                           function (e) { return e.message })`,
      );
      ctx.runtime.executePendingJobs();
      const state = ctx.getPromiseState(ctx.unwrapResult(evaluated));
      expect(state.type).toBe('fulfilled');
      if (state.type !== 'fulfilled') return;
      expect(ctx.getString(state.value)).toBe("could not load module 'node:child_process'");
      state.value.dispose();
    } finally {
      ctx.dispose();
    }
  });
});

describe('客体域的全局面被逐名钉死', () => {
  /**
   * 程序**真正看到**的那张表：62 个 ECMAScript 内建，加上 prelude 装的 `console`
   * 与 `xm`。QuickJS 升级后多出任何一个名字，这里都会红，由人来判断它该不该进来。
   *
   * `__xm_call` / `__xm_log` 不在表里是刻意的：prelude 建完命名空间就把它们删掉了。
   * 不是安全边界（闭包里还留着引用），是让 SDK 里承诺的形状成为程序唯一能用的形状。
   */
  it('只有 ECMAScript 内建加上我们注入的两个名字', async () => {
    expect(await inGuest(`return Object.getOwnPropertyNames(globalThis).sort();`)).toEqual([
      'AggregateError', 'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array',
      'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array',
      'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array',
      'Int8Array', 'InternalError', 'Iterator', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object',
      'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set',
      'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError',
      'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakRef',
      'WeakSet', 'console', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
      'escape', 'eval', 'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined',
      'unescape', 'xm',
    ]);
  });

  it('绑定只有装配方给的那些，别的名字在 xm 上不存在', async () => {
    expect(await inGuest(`return [typeof xm.fs.read, typeof (xm.shell || {}).exec];`)).toEqual([
      'function',
      'undefined',
    ]);
  });
});
