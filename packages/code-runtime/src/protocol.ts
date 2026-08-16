import type { CodeRuntimeBudget, CodeRuntimeErrorKind } from '@xm/kernel';

/**
 * 宿主线程与 worker 之间的消息形状。
 *
 * 两侧共用这一份**只有类型**的模块：worker 那一侧是 `import type`，编译后整句消失，
 * 于是 `code-worker.ts` 在运行期没有任何包内相对导入——它必须自成一体，因为它既要能
 * 以 `dist/code-worker.js` 被加载，也要能在测试里以 `src/code-worker.ts` 被加载
 * （Node 22.18 起默认剥类型），而后者不会把 `./protocol.js` 解析到 `./protocol.ts`。
 */

/** 派生 worker 时的初始载荷。JSON 可序列化，不含函数 */
export interface CodeWorkerBoot {
  readonly budget: CodeRuntimeBudget;
}

/** 宿主要 worker 跑一段程序 */
export interface CodeWorkerRun {
  readonly kind: 'run';
  readonly runId: number;
  readonly source: string;
  readonly bindings: readonly string[];
  readonly nowMs: number;
  readonly randomSeed: string;
}

/** 宿主对一次绑定调用的答复 */
export interface CodeWorkerCallResult {
  readonly kind: 'call-result';
  readonly runId: number;
  readonly callSeq: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly message?: string;
  readonly code?: string;
}

export type CodeWorkerRequest = CodeWorkerRun | CodeWorkerCallResult;

/** worker 请求宿主执行一次绑定调用 */
export interface CodeWorkerCall {
  readonly kind: 'call';
  readonly runId: number;
  readonly callSeq: number;
  readonly name: string;
  readonly input: unknown;
}

/** 这一段程序结束了 */
export interface CodeWorkerDone {
  readonly kind: 'done';
  readonly runId: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly logs: readonly string[];
  readonly clipped: boolean;
  readonly error?: { readonly kind: CodeRuntimeErrorKind; readonly message: string };
}

/** worker 起来了，可以接活。宿主等到它才发第一条 `run` */
export interface CodeWorkerReady {
  readonly kind: 'ready';
}

export type CodeWorkerResponse = CodeWorkerCall | CodeWorkerDone | CodeWorkerReady;
