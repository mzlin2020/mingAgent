import { parentPort, workerData } from 'node:worker_threads';
import * as releaseAsyncify from '@jitl/quickjs-wasmfile-release-asyncify';
import { newQuickJSAsyncWASMModuleFromVariant } from 'quickjs-emscripten-core';
import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten-core';
import ts from 'typescript';
import type {
  CodeWorkerBoot,
  CodeWorkerCallResult,
  CodeWorkerDone,
  CodeWorkerRequest,
  CodeWorkerRun,
} from './protocol.js';

/**
 * Code Mode 的 worker 入口（ADR-0069）。
 *
 * ⚠️ **本文件不许有包内的运行期 import，一句也不行。** 它有两条被加载的路径——
 * 生产里是 `dist/code-worker.js`，测试里是 `src/code-worker.ts`（Node 22.18 起默认
 * 剥类型）——而剥类型那条路**不会**把 `./x.js` 解析到 `./x.ts`（已实测）。
 * 所以包内的东西只能 `import type`（编译后整句消失），外部包按名字导入两条路都成立。
 * 客体域的 prelude 因此写在本文件里，而不是拆出去。
 *
 * 它做四件事，顺序不可换：
 *   1. 用**仓库已有的 TS 6 编译器 API** 剥类型（ADR-0069 §四，不引入新转译器）
 *   2. 起一个**全新的** WASM 模块——内存上限在被别的 runtime 用过的模块上不再生效（§三.4 实测）
 *   3. 装绑定：同步形态的 `__xm_call`（asyncify 折叠掉宿主那侧的 async）与一个日志口
 *   4. 求值，把结果、日志、失败分类回传
 *
 * 它**不判断权限**。绑定调用原样转给宿主，由十二步链去判。
 */

const port = parentPort;
if (port === null) throw new Error('code-worker 必须作为 worker 线程启动。');

const boot = workerData as CodeWorkerBoot;

/** 在途的绑定调用：callSeq → resolve。宿主答复回来时按它派发 */
const pending = new Map<number, (result: CodeWorkerCallResult) => void>();
let callSeq = 0;

port.on('message', (message: CodeWorkerRequest) => {
  if (message.kind === 'call-result') {
    const resolve = pending.get(message.callSeq);
    pending.delete(message.callSeq);
    resolve?.(message);
    return;
  }
  void runProgram(message).then((done) => {
    port.postMessage(done);
  });
});
port.postMessage({ kind: 'ready' });

/** 把一次绑定调用交给宿主，等它走完十二步链再回来 */
const askHost = (runId: number, name: string, input: unknown): Promise<CodeWorkerCallResult> =>
  new Promise((resolve) => {
    callSeq += 1;
    const seq = callSeq;
    pending.set(seq, resolve);
    port.postMessage({ kind: 'call', runId, callSeq: seq, name, input });
  });

async function runProgram(run: CodeWorkerRun): Promise<CodeWorkerDone> {
  const logs: string[] = [];
  // 对象而不是 let：`clipped` 只在下面这个闭包里被改，用局部变量的话类型收窄会认定它恒为 false
  const limit = { clipped: false };
  const log = (line: string): void => {
    if (logs.length >= boot.budget.maxLogs) {
      limit.clipped = true;
      return;
    }
    if (line.length > boot.budget.maxLogChars) limit.clipped = true;
    logs.push(line.slice(0, boot.budget.maxLogChars));
  };

  let compiled: string;
  try {
    compiled = transpile(run.source);
  } catch (error) {
    return fail(run, logs, limit.clipped, 'compile', messageOf(error));
  }

  /*
   * `module.newContext()` 而不是 `module.newRuntime().newContext()`。
   *
   * 两者都能设上限，但**只有前者的收尾是干净的**（实测）：自己建 runtime 的话，
   * 装过 asyncified 绑定之后 `ctx.dispose(); runtime.dispose()` 会在 wasm 层抛
   * `QuickJSRuntime not found when trying to free HostRef`，而只 dispose runtime
   * 又会撞 `Assertion failed: list_empty(&rt->gc_obj_list)`。
   * `newContext()` 建的 runtime 由 context 自己持有并同批释放，两条都不发生。
   * 上限照样设得上——经 `ctx.runtime` 就行。
   */
  const module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  const ctx = module.newContext();
  ctx.runtime.setMemoryLimit(boot.budget.memoryBytes);
  const startedAt = Date.now();
  ctx.runtime.setInterruptHandler(() => Date.now() - startedAt > boot.budget.cpuMs);
  try {
    const callFn = ctx.newAsyncifiedFunction('__xm_call', async (nameHandle, inputHandle) => {
      const name = ctx.getString(nameHandle);
      const inputJson = ctx.getString(inputHandle);
      const answer = await askHost(run.runId, name, parseInput(inputJson));
      return ctx.newString(
        JSON.stringify(
          answer.ok
            ? { ok: true, value: answer.value }
            : { ok: false, message: answer.message ?? '子调用失败。', code: answer.code },
        ),
      );
    });
    ctx.setProp(ctx.global, '__xm_call', callFn);
    callFn.dispose();

    const logFn = ctx.newFunction('__xm_log', (handle) => {
      log(ctx.getString(handle));
    });
    ctx.setProp(ctx.global, '__xm_log', logFn);
    logFn.dispose();

    const prelude = ctx.evalCode(guestPrelude(run.nowMs, seedOf(run.randomSeed), run.bindings));
    if (prelude.error !== undefined) {
      return fail(run, logs, limit.clipped, 'substrate', thrownBy(ctx, prelude.error).message);
    }
    prelude.value.dispose();

    const evaluated = await ctx.evalCodeAsync(wrapProgram(compiled));
    if (evaluated.error !== undefined) {
      const thrown = thrownBy(ctx, evaluated.error);
      return fail(run, logs, limit.clipped, failureKind(thrown), thrown.message);
    }
    const encoded = ctx.getString(evaluated.value);
    evaluated.value.dispose();
    const value = boundValue((JSON.parse(encoded) as { v?: unknown }).v, boot.budget.maxValueChars);
    return {
      kind: 'done',
      runId: run.runId,
      ok: true,
      logs,
      clipped: limit.clipped || value.clipped,
      ...(value.value === undefined ? {} : { value: value.value }),
    };
  } catch (error) {
    return fail(run, logs, limit.clipped, 'substrate', messageOf(error));
  } finally {
    ctx.dispose();
  }
}

/**
 * 客体域的 prelude。**它先于程序求值，程序看到的全局面由它定形。**
 *
 * 三件事：
 *
 * 1. `Date` 与 `Math.random` 换成宿主的投影（ADR-0069 §三.1）。它们是 ECMAScript
 *    内建，客体域挡不住——不换掉，Code Mode 就是确定性闸门上的一个洞，
 *    而 `pnpm check:determinism` 扫的是仓库源码，扫不到模型现写的一段程序。
 *    时间在程序里**不流逝**：`Date.now()` 全程是同一个数（要量耗时就调工具）。
 * 2. `console` 接到日志口。客体域本来没有 console，程序里一句 `console.log` 会直接抛。
 * 3. 按绑定名建 `xm.fs.read(...)` 这样的嵌套命名空间，并在建完之后**删掉**
 *    `__xm_call` / `__xm_log` 两个裸口子——不是安全边界（闭包里还留着引用），
 *    是让程序只有一种写法，SDK 里承诺的形状就是它唯一能用的形状。
 */
function guestPrelude(nowMs: number, seed: number, bindings: readonly string[]): string {
  return `"use strict";
(function () {
  var __now = ${JSON.stringify(nowMs)};
  var __RealDate = Date;
  function XmDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!new.target) return Reflect.construct(__RealDate, [__now]).toString();
    return Reflect.construct(__RealDate, args.length === 0 ? [__now] : args);
  }
  XmDate.prototype = __RealDate.prototype;
  XmDate.now = function () { return __now; };
  XmDate.parse = __RealDate.parse;
  XmDate.UTC = __RealDate.UTC;
  globalThis.Date = XmDate;

  var __seed = ${JSON.stringify(seed)} >>> 0;
  if (__seed === 0) __seed = 0x9e3779b9;
  Math.random = function () {
    __seed ^= __seed << 13; __seed >>>= 0;
    __seed ^= __seed >>> 17;
    __seed ^= __seed << 5; __seed >>>= 0;
    return __seed / 4294967296;
  };

  var __log = globalThis.__xm_log;
  var __call = globalThis.__xm_call;
  function __fmt() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'string') { parts.push(v); continue; }
      try { parts.push(JSON.stringify(v)); } catch (e) { parts.push(String(v)); }
    }
    return parts.join(' ');
  }
  var __write = function () { __log(__fmt.apply(null, arguments)); };
  globalThis.console = { log: __write, info: __write, warn: __write, error: __write, debug: __write };

  function __invoke(name, input) {
    var raw = __call(name, JSON.stringify(input === undefined ? {} : input));
    var res = JSON.parse(raw);
    if (!res.ok) {
      var err = new Error(res.message);
      err.code = res.code;
      err.tool = name;
      throw err;
    }
    return res.value;
  }
  var __names = ${JSON.stringify([...bindings])};
  var xm = {};
  for (var n = 0; n < __names.length; n++) {
    var parts = __names[n].split('.');
    var node = xm;
    for (var p = 0; p < parts.length - 1; p++) {
      if (node[parts[p]] === undefined) node[parts[p]] = {};
      node = node[parts[p]];
    }
    node[parts[parts.length - 1]] = (function (name) {
      return function (input) { return __invoke(name, input); };
    })(__names[n]);
  }
  globalThis.xm = xm;
  delete globalThis.__xm_call;
  delete globalThis.__xm_log;
})();`;
}

/**
 * 程序体的包装。
 *
 * 程序是一个**同步函数体**，用 `return` 交回结果——不是模块，也不写 `await`
 * （ADR-0069 §三.2：绑定是同步形态，`await` 那条路实测会让程序静默半途而废）。
 * 返回值当场 JSON 化，跨不了 JSON 的东西在这里就报错，而不是变成客体域里一个
 * 神秘的 `undefined`。
 */
const wrapProgram = (compiled: string): string => `(function () {
  var __v = (function () {
${compiled}
  })();
  try { return JSON.stringify({ v: __v }); }
  catch (e) { throw new Error('程序的返回值不能 JSON 序列化：' + String(e && e.message)); }
})()`;

/**
 * 剥类型。**只剥，不做类型检查**——类型错误由模型自己承担，这里报的是语法错。
 *
 * `module: ESNext` 而不是 `None`：后者在 TS 6 里已标记弃用、TS 7 会停止工作
 * （实测报错），而本仓库的编译器正是 TS 7（ADR-0010）。用一个"下个大版本就没了"的
 * 选项换一条错误消息不划算。代价是 `import` 会原样留在输出里，于是它在包装成函数体
 * 之后变成一条 SyntaxError——`failureKind` 因此把 SyntaxError 归到 `compile`，
 * 模型看到的仍然是"你这段代码编不过"，而不是"运行时炸了"。
 */
function transpile(source: string): string {
  const out = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
    reportDiagnostics: true,
  });
  const fatal = out.diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (fatal !== undefined) throw new Error(ts.flattenDiagnosticMessageText(fatal.messageText, '\n'));
  return out.outputText;
}

/**
 * 变体包只发了一份 CJS 类型声明，于是 TS 把默认导入建模成整个模块命名空间，
 * 而 Node 的互操作实际给到的就是变体对象本身。这处转换补的是模型与运行时的偏差，
 * 目标类型直接取自那个函数的形参（同一处说明见 `evals/spikes/h2-*.test.ts`）。
 */
const variant = releaseAsyncify.default as unknown as Parameters<
  typeof newQuickJSAsyncWASMModuleFromVariant
>[0];

const fail = (
  run: CodeWorkerRun,
  logs: readonly string[],
  clipped: boolean,
  kind: NonNullable<CodeWorkerDone['error']>['kind'],
  message: string,
): CodeWorkerDone => ({
  kind: 'done',
  runId: run.runId,
  ok: false,
  logs: [...logs],
  clipped,
  error: { kind, message },
});

/** 客体域抛出来的未必是 Error，取不到 name/message 就整体 JSON 化 */
function thrownBy(
  ctx: QuickJSAsyncContext,
  handle: QuickJSHandle,
): { readonly name: string; readonly message: string } {
  const dumped: unknown = ctx.dump(handle);
  handle.dispose();
  if (typeof dumped === 'object' && dumped !== null && 'message' in dumped) {
    const shape = dumped as { name?: unknown; message: unknown };
    return {
      name: typeof shape.name === 'string' ? shape.name : '',
      message: asText(shape.message),
    };
  }
  return { name: '', message: asText(dumped) };
}

/**
 * QuickJS 用同一个通道报预算耗尽、语法错与程序抛错，只能靠 name/message 分辨。
 *
 * SyntaxError 归 `compile`：走到这一步的语法错只有一个来源——程序里写了 `import`
 * （剥类型不管它，客体域也没有模块加载器）。对模型来说那就是"这段代码编不过"。
 */
const failureKind = (thrown: {
  readonly name: string;
  readonly message: string;
}): 'cpu' | 'memory' | 'compile' | 'throw' => {
  if (thrown.message === 'interrupted') return 'cpu';
  if (thrown.message === 'out of memory') return 'memory';
  return thrown.name === 'SyntaxError' ? 'compile' : 'throw';
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : asText(error));

/** 任意值 → 一行可读文本。JSON 化不了（循环引用、BigInt）时不要再去 String() 它 */
const asText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json : '（无法序列化的值）';
};

const parseInput = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
};

/** FNV-1a：把种子字符串折成一个 32 位数。种子确定 → 序列确定 */
function seedOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 返回值也要有上限：程序可以 `return` 一个一百兆的字符串 */
function boundValue(value: unknown, maxChars: number): { value: unknown; clipped: boolean } {
  if (value === undefined) return { value: undefined, clipped: false };
  const encoded = asText(value);
  if (encoded.length <= maxChars) return { value, clipped: false };
  return {
    value: `（返回值 ${String(encoded.length)} 字符，超过 ${String(maxChars)} 上限，已截断）${encoded.slice(0, maxChars)}`,
    clipped: true,
  };
}
