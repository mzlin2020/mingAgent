/**
 * H2 隔离机制的验收（[ADR-0069](../../docs/adr/0069-CodeMode的隔离机制.md)）。
 *
 * ADR-0061 §一 承诺"程序拿不到 `node:fs` / `child_process` / `net`"，
 * 而它当时假设的普通 Node worker 给不了这个属性——那份 ADR 因此被降级为 🟡 Proposed。
 * 本文件是把承诺变成可执行断言的地方：
 *
 *   · 同一段探针程序在**两个提供者**里各跑一遍：QuickJS 客体域必须全部拿不到，
 *     朴素 Node worker 必须全部拿得到。第二半是反向演练——没有它，第一半只是
 *     一句无法证伪的断言，正是本仓库栽过八次的形状。
 *   · 客体域的全局面被逐名钉死。QuickJS 升级后多出一个 `std` / `os`，这里必须红。
 *   · 预算与绑定的真实形状：CPU 预算、内存上限、绑定是同步形态、
 *     以及"永不完成的程序不会触发 interrupt handler"——最后一条决定了
 *     M3-h 必须另有一个宿主侧的墙钟。
 *
 * 它跑在 `pnpm test` / `pnpm verify` 里（`vitest.config.ts` 的 include 已含 `evals/**`），
 * 不需要新开闸门。M3-h 落地 `ctx.codeRuntime` 时，这些断言应当搬进那个包的用例，
 * 本文件随之退役。
 */
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import * as releaseAsyncify from '@jitl/quickjs-wasmfile-release-asyncify';
import { newQuickJSAsyncWASMModuleFromVariant } from 'quickjs-emscripten-core';
import type { QuickJSAsyncWASMModule } from 'quickjs-emscripten-core';

/**
 * 四条穿透探针，**两个世界共用同一段源码**。
 *
 * 共用是关键：如果两边跑的是各自写的代码，"一边红一边绿"就可能只是两段代码不一样，
 * 而不是两个隔离机制不一样。
 */
const PROBE = `(function () {
  var verdict = {};
  try {
    var fs = require('node:fs');
    verdict.require = typeof fs.readFileSync === 'function' ? '拿到了' : '拿到了但形状不对';
  } catch (e) { verdict.require = '拿不到'; }
  verdict.process = typeof process === 'undefined' ? '拿不到' : '拿到了';
  verdict.fetch = typeof fetch === 'undefined' ? '拿不到' : '拿到了';
  try { Function('return process')(); verdict.functionCtor = '拿到了'; }
  catch (e) { verdict.functionCtor = '拿不到'; }
  return JSON.stringify(verdict);
})()`;

type Verdict = Record<'require' | 'process' | 'fetch' | 'functionCtor', string>;

/**
 * 每条用例都拿一个**全新的** WASM 模块（实测冷启动 ~21 ms，不值得省）。
 *
 * 共用一个模块会让用例互相污染：实测内存上限在"已经有别的 runtime 用过"的模块上
 * 不再生效，直接把宿主的 V8 堆撑到 2 GB 崩掉。隔离机制的用例本身被共享状态串了味，
 * 是最不该出现的事——顺带这也是 M3-h 的一条约束：**一个程序一个 WASM 模块**。
 */
/**
 * 变体包只发了一份 **CJS** 类型声明（`exports` 的 `types` 条件不分 import/require），
 * 于是 TS 把默认导入建模成"整个模块命名空间"，而 Node 的 ESM/CJS 互操作实际给到的
 * 就是变体对象本身（已实测）。这一处转换补的是模型与运行时的这个偏差，
 * 不是在绕过类型——目标类型直接取自那个函数的形参，不另写一份。
 */
const variant = releaseAsyncify.default as unknown as Parameters<
  typeof newQuickJSAsyncWASMModuleFromVariant
>[0];

const quickjs = (): Promise<QuickJSAsyncWASMModule> =>
  newQuickJSAsyncWASMModuleFromVariant(variant);

/** 在 QuickJS 客体域里求值一段表达式，取回它的字符串结果。 */
const evalInGuest = async (code: string): Promise<string> => {
  const ctx = (await quickjs()).newContext();
  try {
    const result = ctx.evalCode(code);
    if (result.error !== undefined) {
      const dumped: unknown = ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`客体域求值失败：${JSON.stringify(dumped)}`);
    }
    const value = ctx.getString(result.value);
    result.value.dispose();
    return value;
  } finally {
    ctx.dispose();
  }
};

/** 在客体域里 `import(specifier)`，把拒绝理由取回来。 */
const importInGuest = async (specifier: string): Promise<string> => {
  const ctx = (await quickjs()).newContext();
  try {
    const result = ctx.evalCode(
      `import(${JSON.stringify(specifier)}).then(function () { return '装上了'; }, function (e) { return e.message; })`,
    );
    if (result.error !== undefined) {
      const dumped: unknown = ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`客体域求值失败：${JSON.stringify(dumped)}`);
    }
    ctx.runtime.executePendingJobs();
    const state = ctx.getPromiseState(result.value);
    result.value.dispose();
    if (state.type !== 'fulfilled') throw new Error(`import 的结果既没成也没败：${state.type}`);
    const message = ctx.getString(state.value);
    state.value.dispose();
    return message;
  } finally {
    ctx.dispose();
  }
};

/** 朴素 Node worker 提供者——**这就是 ADR-0061 初稿假设的那个东西**。 */
const evalInNaiveWorker = (code: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort } = require('node:worker_threads');\nparentPort.postMessage(${code});`,
      { eval: true },
    );
    worker.once('message', (message: string) => {
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', reject);
  });

describe('H2 · 客体域拿不到宿主能力', () => {
  it('四条穿透探针在 QuickJS 客体域里全部拿不到', async () => {
    const verdict = JSON.parse(await evalInGuest(PROBE)) as Verdict;
    expect(verdict).toEqual({
      require: '拿不到',
      process: '拿不到',
      fetch: '拿不到',
      functionCtor: '拿不到',
    });
  });

  /**
   * 反向演练：**同一段探针**换成朴素 Node worker，必须全部穿透。
   *
   * 上面那条断言若因为探针写错而恒真，这一条就会跟着绿——两条一起看才有意义。
   */
  it('反向演练：同一段探针在朴素 Node worker 里全部穿透', async () => {
    const verdict = JSON.parse(await evalInNaiveWorker(PROBE)) as Verdict;
    expect(verdict).toEqual({
      require: '拿到了',
      process: '拿到了',
      fetch: '拿到了',
      functionCtor: '拿到了',
    });
  });

  it.each(['node:child_process', 'node:fs', 'fs'])(
    '客体域没有模块加载器，动态 import(%s) 被拒绝',
    async (specifier) => {
      expect(await importInGuest(specifier)).toBe(`could not load module '${specifier}'`);
    },
  );
});

describe('H2 · 客体域的全局面被逐名钉死', () => {
  /**
   * 这是本段最重要的一条断言：**允许存在什么**，而不是"不允许存在什么"。
   *
   * 按"不允许"写的清单会漏（写清单的人想不到 `std`），按"允许"写的清单不会——
   * QuickJS 升级后多出任何一个名字，这里都会红，由人来判断它该不该进来。
   * 这与 ADR-0063 把"工具不得碰 node:*"从文件名单升级成包边界规则是同一条纪律。
   */
  it('全局面只有 ECMAScript 内建，一个宿主 API 都没有', async () => {
    const names = JSON.parse(
      await evalInGuest(`JSON.stringify(Object.getOwnPropertyNames(globalThis).sort())`),
    ) as string[];
    expect(names).toEqual([
      'AggregateError', 'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array',
      'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array',
      'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array',
      'Int8Array', 'InternalError', 'Iterator', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object',
      'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set',
      'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError',
      'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakRef',
      'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
      'eval', 'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape',
    ]);
  });

  /**
   * `Date` 与 `Math.random` **在客体域里是存在的**——它们是 ECMAScript 内建，
   * 不是宿主 API，客体域挡不住它们。
   *
   * 这条断言是写给 M3-h 的：Code Mode 若不在装载绑定时把这两个替换成
   * `ctx.clock` / `ctx.ids` 的投影（[ADR-0066](../../docs/adr/0066-时钟与ID的注入.md)），
   * 它就是确定性闸门上的一个洞——`pnpm check:determinism` 盯的是仓库源码，
   * 盯不到模型现写的一段程序。
   */
  it('客体域自带 Date 与 Math.random，宿主必须显式覆盖', async () => {
    expect(await evalInGuest(`typeof Date + '/' + typeof Math.random`)).toBe('function/function');
    const overridden = await evalInGuest(
      `Date.now = function () { return 42 }; Math.random = function () { return 0.5 };
       String(Date.now()) + '/' + String(Math.random())`,
    );
    expect(overridden).toBe('42/0.5');
  });
});

describe('H2 · 预算与绑定', () => {
  it('死循环被 interrupt handler 打断，宿主线程随后仍可用', async () => {
    const runtime = (await quickjs()).newRuntime();
    const started = Date.now();
    runtime.setInterruptHandler(() => Date.now() - started > 200);
    const ctx = runtime.newContext();
    try {
      const result = ctx.evalCode(`let i = 0; while (true) { i++ } i`);
      expect(result.error).toBeDefined();
      const dumped = ctx.dump(result.error!) as { message?: string };
      result.error!.dispose();
      expect(dumped.message).toBe('interrupted');
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
    // 宿主没被拖走：换一个 realm 立刻还能正常求值。
    expect(await evalInGuest(`String(1 + 1)`)).toBe('2');
  });

  it('内存上限触发 out of memory 而不是拖垮宿主', async () => {
    const runtime = (await quickjs()).newRuntime();
    runtime.setMemoryLimit(1024 * 1024);
    const ctx = runtime.newContext();
    try {
      // 一次性要一大块，而不是循环慢慢涨：后者在 vitest 环境下要跑十几秒才撞到天花板。
      const result = ctx.evalCode(`const a = new Array(2000000).fill(1); a.length`);
      expect(result.error).toBeDefined();
      const dumped = ctx.dump(result.error!) as { message?: string };
      result.error!.dispose();
      expect(dumped.message).toBe('out of memory');
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  });

  /**
   * 绑定在客体域里是**同步形态**：asyncify 把宿主那一侧的 `async` 折叠掉，
   * 程序写 `const a = callTool(...)`，不写 `await`。
   *
   * ADR-0061 §五 原话是"把每个可见工具生成成一个 TS 异步函数"，那是照参考实现写的——
   * 在这个机制下不成立，SDK 必须生成**同步签名**。`await` 那条路实测不可靠：
   * module 模式下串行两次 `await` 会让程序静默半途而废，随后在 wasm 层抛
   * `null function or function signature mismatch`。详见
   * [H2 隔离机制验证记录](../../docs/experience/m3/H2-隔离机制验证记录.md)。
   */
  it('绑定往返：宿主做真异步 I/O，客体域拿到直接返回值', async () => {
    const ctx = (await quickjs()).newContext();
    const seen: string[] = [];
    const fn = ctx.newAsyncifiedFunction('callTool', async (handle) => {
      const name = ctx.getString(handle);
      seen.push(name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ctx.newString(`结果:${name}`);
    });
    ctx.setProp(ctx.global, 'callTool', fn);
    fn.dispose();
    try {
      const result = await ctx.evalCodeAsync(
        `const a = callTool('fs.read'); const b = callTool('fs.write'); a + '|' + b`,
      );
      const value = ctx.unwrapResult(result);
      expect(ctx.getString(value)).toBe('结果:fs.read|结果:fs.write');
      value.dispose();
      expect(seen).toEqual(['fs.read', 'fs.write']);
    } finally {
      ctx.dispose();
    }
  });

  it('同步形态的绑定可以连调很多次而不失稳', async () => {
    const ctx = (await quickjs()).newContext();
    let calls = 0;
    const fn = ctx.newAsyncifiedFunction('callTool', async (handle) => {
      calls += 1;
      const name = ctx.getString(handle);
      await new Promise((resolve) => setImmediate(resolve));
      return ctx.newString(name.toUpperCase());
    });
    ctx.setProp(ctx.global, 'callTool', fn);
    fn.dispose();
    try {
      const result = await ctx.evalCodeAsync(
        `let out = ''; for (let i = 0; i < 50; i++) { out = callTool('t' + i) } out`,
      );
      const value = ctx.unwrapResult(result);
      expect(ctx.getString(value)).toBe('T49');
      value.dispose();
      expect(calls).toBe(50);
    } finally {
      ctx.dispose();
    }
  });

  /**
   * **interrupt handler 是 CPU 预算，不是墙钟预算。**
   *
   * 程序停在一个永不 settle 的 promise 上时，客体域里没有任何字节码在跑，
   * interrupt handler 之后再也不会被问到，而求值调用早就返回了。
   * 所以 M3-h 的 `run_code` **必须另有一个宿主侧的墙钟截止时间**，
   * 把"到点仍未完成"判成失败——只靠 interrupt handler 会漏掉这一整类。
   */
  it('永不完成的程序不会触发 interrupt handler，宿主必须自己设墙钟', async () => {
    const runtime = (await quickjs()).newRuntime();
    let asked = 0;
    runtime.setInterruptHandler(() => {
      asked += 1;
      return false;
    });
    const ctx = runtime.newContext();
    try {
      const started = ctx.evalCode(
        `globalThis.走完了 = false;
         new Promise(function () {}).then(function () { globalThis.走完了 = true });
         '交回宿主'`,
      );
      const marker = ctx.unwrapResult(started);
      expect(ctx.getString(marker)).toBe('交回宿主');
      marker.dispose();
      ctx.runtime.executePendingJobs();
      const done = ctx.unwrapResult(ctx.evalCode(`String(globalThis.走完了)`));
      expect(ctx.getString(done)).toBe('false'); // 程序没完成
      done.dispose();
      expect(asked).toBeLessThanOrEqual(1); // 而 interrupt handler 一次也没再被问
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  });
});
