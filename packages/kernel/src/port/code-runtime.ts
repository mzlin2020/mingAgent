import type { AbortLike } from './abort.js';

/**
 * 隔离代码运行时端口（ADR-0061 §三 / ADR-0069）。
 *
 * 它定义的是"跑一段程序、给一组绑定、把结果拿回来"，**不认识工具、不认识会话、
 * 不认识权限**。真正的隔离机制（QuickJS-WASM 客体域 + worker 线程）是适配器的事，
 * 内核这一侧只有类型。
 *
 * ⚠️ **隔离不是安全边界。** 越权由 ADR-0055 的十二步闸门链挡；客体域挡的是
 * "程序绕过绑定直接干活"。两件事，别混。
 */

/** 程序对一个绑定发起的一次调用。`input` 是程序给的 JSON 值，**未经校验** */
export interface CodeBindingCall {
  readonly name: string;
  readonly input: unknown;
}

/**
 * 一次绑定调用的结果。
 *
 * 失败**不抛到宿主**：它变成客体域里的一个异常，程序可以 catch 并调整
 * （ADR-0061 §一）。所以这里用 `ok` 而不是 reject——宿主侧的 reject 会中止整段程序，
 * 那就把"模型能自己救回来"这条路堵死了。
 */
export interface CodeBindingResult {
  readonly ok: boolean;
  /** 成功时的返回值：工具的**规范输出值**（ADR-0071），不是给模型看的散文 */
  readonly value?: unknown;
  /** 失败时程序里那个异常的消息。**拒绝理由与直接调用一字不差** */
  readonly message?: string;
  /** 失败时的错误码（`XmError.code`），让程序能按类别分支而不是匹配中文 */
  readonly code?: string;
}

/**
 * 整段程序失败的分类。
 *
 * `substrate` 是"隔离层自己坏了"（worker 崩了、WASM 起不来），与程序写错要分开——
 * 前者该报故障并可重试，后者该把错误交回模型让它改。
 */
export type CodeRuntimeErrorKind =
  | 'compile'
  | 'throw'
  | 'timeout'
  | 'cpu'
  | 'memory'
  | 'aborted'
  | 'substrate';

export interface CodeRuntimeResult {
  readonly ok: boolean;
  /** 程序最后一个表达式的值，已经过 JSON 往返；`undefined` 表示程序没返回东西 */
  readonly value?: unknown;
  /** 程序里 `console.log` 出来的行，已按预算截断 */
  readonly logs: readonly string[];
  readonly error?: { readonly kind: CodeRuntimeErrorKind; readonly message: string };
  /** 日志或返回值因为超出预算被截断过 */
  readonly clipped: boolean;
}

export interface CodeRuntimeInput {
  /** TypeScript 源码。剥类型由提供者负责（ADR-0069 §四），调用方不预处理 */
  readonly source: string;
  /** 要装进客体域的绑定名，形如 `fs.read`。点号分段会被装成嵌套对象 */
  readonly bindings: readonly string[];
  /** 绑定被调用时回到宿主。提供者负责把它折叠成客体域里的**同步**签名 */
  call(request: CodeBindingCall): Promise<CodeBindingResult>;
  /**
   * 客体域里 `Date.now()` 的取值（ADR-0069 §三.1）。
   *
   * **整段程序里它是常量**——客体域里时间不流逝。这不是偷懒：
   * 一是每次读时间都往返宿主，代价与语义都不划算；二是冻住之后 Code Mode 天然落在
   * 确定性闸门内，而 `pnpm check:determinism` 扫的是仓库源码，扫不到模型现写的程序。
   * 程序想量耗时，去调工具，让宿主的墙钟说话。
   */
  readonly nowMs: number;
  /**
   * 客体域里 `Math.random()` 的种子（ADR-0069 §三.1）。
   *
   * 传种子而不是每次回宿主取一个数，理由同上。生产里它取自父调用的 `callId`
   * （uuidv4），确定性 profile 下 `callId` 本身就是可预测的，于是这段程序的随机序列
   * 也可预测——这正是快照验收要的性质。
   */
  readonly randomSeed: string;
  readonly signal: AbortLike;
}

/**
 * 预算。**是提供者的配置字段，不是硬编码常量**（ADR-0061 §四）。
 *
 * `wallClockMs` 与 `cpuMs` 两条都要有，缺一不可：interrupt handler 只在有字节码
 * 执行时才被问到，程序停在一个永不 settle 的 promise 上时它一次也不会触发
 * （ADR-0069 §三.3 的实测）。只留 CPU 预算会漏掉一整类挂死。
 */
export interface CodeRuntimeBudget {
  readonly wallClockMs: number;
  readonly cpuMs: number;
  readonly memoryBytes: number;
  readonly maxLogs: number;
  readonly maxLogChars: number;
  readonly maxValueChars: number;
}

export interface CodeRuntime {
  /** 提供者身份，形如 `quickjs`。进 `run_code` 的结果，方便事后对账 */
  readonly kind: string;
  readonly budget: CodeRuntimeBudget;
  /**
   * 跑一段程序。
   *
   * **只报告失败，不抛失败**（ADR-0061 §三）：解析错、程序抛异常、超预算、被取消、
   * 隔离层死亡，全部作为 `error` 返回。只有调用方违反接口契约时才 reject。
   */
  run(input: CodeRuntimeInput): Promise<CodeRuntimeResult>;
}
