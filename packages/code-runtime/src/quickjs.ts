import { Worker } from 'node:worker_threads';
import type {
  CodeRuntime,
  CodeRuntimeBudget,
  CodeRuntimeErrorKind,
  CodeRuntimeInput,
  CodeRuntimeResult,
} from '@xm/kernel';
import type { CodeWorkerBoot, CodeWorkerResponse } from './protocol.js';

/**
 * `CodeRuntime` 的 QuickJS 实现（ADR-0069）。宿主这一侧。
 *
 * ── 两层各挡一件事 ──
 *
 * · **客体域**挡权限：那里没有 `require` / `process` / `fetch`，能力只从绑定进来。
 *   这是结构性的 deny-by-default，不是枚举出来的开关清单。
 * · **worker 线程**挡稳定性：interrupt handler 能中断客体域，但它在**宿主线程**上跑，
 *   预算窗口内会把 Electron 主进程冻住。换到 worker 里之后，一段死循环最多占住
 *   一条后台线程。
 *
 * ── worker 是长驻的，WASM 模块不是 ──
 *
 * ADR-0069 §三.4 要求"一个程序一个 WASM 模块"（内存上限在被用过的模块上失效），
 * 但**没有**要求一个程序一个 worker——而 TS 编译器首次加载要 778 ms，
 * 每段程序都重付一次是纯浪费。所以 worker 长驻、模块每次新建：21 ms 的冷启动买
 * 一个干净的内存账本，划算。
 *
 * 超预算或被取消时 worker 被 `terminate()`，下一次 `run()` 再起一个新的——
 * 那时才重付那 778 ms，而那是异常路径。
 *
 * ── 串行 ──
 *
 * 一个 worker 一次只跑一段程序。`run_code` 本身是 `concurrency: 'exclusive'`，
 * 但同一个进程里可以有多个会话，所以这里自己排队。并发调度归宿主（ADR-0005），
 * 不由模型现写的一段程序决定。
 */

export const DEFAULT_CODE_BUDGET: CodeRuntimeBudget = {
  /** 墙钟。**必须有**——程序停在永不 settle 的 promise 上时 CPU 预算一次也不触发 */
  wallClockMs: 30_000,
  cpuMs: 10_000,
  memoryBytes: 64 * 1024 * 1024,
  maxLogs: 200,
  maxLogChars: 4_000,
  maxValueChars: 32_000,
};

export interface QuickJsCodeRuntimeOptions {
  /** 覆盖默认预算。预算是配置字段，不是硬编码常量（ADR-0061 §四） */
  readonly budget?: Partial<CodeRuntimeBudget>;
}

export interface QuickJsCodeRuntime extends CodeRuntime {
  /** 关掉长驻 worker。应用退出与测试收尾都要调，否则进程不肯退出 */
  dispose(): Promise<void>;
}

/**
 * worker 入口。
 *
 * 从 `dist/` 加载时是 `code-worker.js`；测试里跑的是 `src/`，那时同目录下只有
 * `code-worker.ts`，靠 Node 22.18 起默认开启的类型剥离直接加载它。判据是**本模块
 * 自己的扩展名**，不是环境变量——它就是"我现在是源码还是产物"这个问题本身。
 */
const workerEntry = (): URL =>
  new URL(import.meta.url.endsWith('.ts') ? './code-worker.ts' : './code-worker.js', import.meta.url);

export function createQuickJsCodeRuntime(
  options: QuickJsCodeRuntimeOptions = {},
): QuickJsCodeRuntime {
  const budget: CodeRuntimeBudget = { ...DEFAULT_CODE_BUDGET, ...options.budget };
  const boot: CodeWorkerBoot = { budget };
  let worker: Worker | undefined;
  let ready: Promise<Worker> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let runId = 0;

  const spawn = (): Promise<Worker> => {
    const created = new Worker(workerEntry(), { workerData: boot });
    worker = created;
    return new Promise<Worker>((resolve, reject) => {
      const onMessage = (message: CodeWorkerResponse): void => {
        if (message.kind !== 'ready') return;
        created.off('message', onMessage);
        created.off('error', reject);
        resolve(created);
      };
      created.on('message', onMessage);
      created.once('error', reject);
    });
  };

  /** 把 worker 拆掉。超预算、被取消、进程退出都走这里 */
  const teardown = async (): Promise<void> => {
    const current = worker;
    worker = undefined;
    ready = undefined;
    if (current !== undefined) await current.terminate();
  };

  const runOnce = async (input: CodeRuntimeInput): Promise<CodeRuntimeResult> => {
    ready ??= spawn();
    let live: Worker;
    try {
      live = await ready;
    } catch (error) {
      await teardown();
      return substrateFailure(`代码运行时起不来：${messageOf(error)}`);
    }

    runId += 1;
    const id = runId;
    return new Promise<CodeRuntimeResult>((resolve) => {
      let settled = false;
      /*
       * **这一次 run 的运行域**（地基复审四 C2）。
       *
       * `terminate()` 只杀得掉客体域；宿主这一侧已经派发出去的子调用是普通的
       * Promise，没人管它就会继续跑完——一个被墙钟掐掉的程序，它的 `shell.exec`
       * 照样把文件写完，`tool.code.dispatch` 落在 `run_code` 的 `tool.end` 之后。
       * 于是模型看到"程序超时终止"，机器上却仍在发生事情。
       *
       * 所以运行结束（正常、超时、取消、隔离层死亡）第一件事是 abort 它，
       * 再等一小段宽限期让在途的子调用把自己收尾干净。
       */
      const runAborts = new AbortController();
      const inflight = new Set<Promise<unknown>>();

      const finish = (result: CodeRuntimeResult, kill: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        live.off('message', onMessage);
        live.off('error', onError);
        live.off('exit', onExit);
        runAborts.abort();
        if (kill) void teardown();
        void drain(inflight).then(() => {
          resolve(result);
        });
      };

      const onMessage = (message: CodeWorkerResponse): void => {
        if (message.kind === 'call') {
          /*
           * 绑定调用。**宿主这一侧永远不 reject**：被拒绝的子调用要变成客体域里的
           * 一个异常让程序自己 catch（ADR-0061 §一），而不是让整段程序死掉。
           */
          const pending = input
            .call({ name: message.name, input: message.input }, runAborts.signal)
            .then(
              (answer) => ({ ...answer }),
              (error: unknown) => ({ ok: false, message: messageOf(error) }),
            )
            .then((answer) => {
              inflight.delete(pending);
              if (settled) return;
              live.postMessage({ kind: 'call-result', runId: id, callSeq: message.callSeq, ...answer });
            });
          inflight.add(pending);
          return;
        }
        if (message.kind !== 'done' || message.runId !== id) return;
        finish(
          {
            ok: message.ok,
            logs: [...message.logs],
            clipped: message.clipped,
            ...(message.value === undefined ? {} : { value: message.value }),
            ...(message.error === undefined ? {} : { error: message.error }),
          },
          false,
        );
      };

      const onError = (error: Error): void => {
        finish(substrateFailure(`代码运行时异常：${error.message}`), true);
      };
      const onExit = (code: number): void => {
        finish(substrateFailure(`代码运行时提前退出（code=${String(code)}）。`), true);
      };
      const onAbort = (): void => {
        finish(budgetFailure('aborted', '这一轮已被中断，程序未跑完。'), true);
      };

      const timer = setTimeout(() => {
        finish(
          budgetFailure('timeout', `程序超过 ${String(budget.wallClockMs)} ms 墙钟上限，已终止。`),
          true,
        );
      }, budget.wallClockMs);

      live.on('message', onMessage);
      live.once('error', onError);
      live.once('exit', onExit);
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort);

      live.postMessage({
        kind: 'run',
        runId: id,
        source: input.source,
        bindings: [...input.bindings],
        nowMs: input.nowMs,
        randomSeed: input.randomSeed,
      });
    });
  };

  return {
    kind: 'quickjs',
    budget,
    run(input) {
      const next = queue.then(() => runOnce(input));
      // 排队链只关心"轮到谁"，不关心结果成败——所以吞掉 rejection，别让它断链
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    dispose: teardown,
  };
}

/**
 * 等在途的子调用收尾。**有上限**——工具收到 abort 之后应当很快返回，但"应当"
 * 不是保证，而一个不肯停的工具不该把整段程序的失败上报也一起拖住。
 * 宽限期过了就先把结果交出去；子调用自己的失败仍然会照常落审计。
 */
const TEARDOWN_GRACE_MS = 1_000;

async function drain(inflight: ReadonlySet<Promise<unknown>>): Promise<void> {
  if (inflight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, TEARDOWN_GRACE_MS);
  });
  await Promise.race([Promise.allSettled([...inflight]).then(() => undefined), grace]);
  if (timer !== undefined) clearTimeout(timer);
}

const substrateFailure = (message: string): CodeRuntimeResult => ({
  ok: false,
  logs: [],
  clipped: false,
  error: { kind: 'substrate', message },
});

const budgetFailure = (kind: CodeRuntimeErrorKind, message: string): CodeRuntimeResult => ({
  ok: false,
  logs: [],
  clipped: false,
  error: { kind, message },
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
