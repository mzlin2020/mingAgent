import type { TurnId, XmError } from '@xm/contracts';
import type { PreparedCall, ToolExecutionResult } from './turn-events.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

/**
 * 一次工具调用的**记录面**（ADR-0072）。
 *
 * ── 为什么要有这层 ──
 *
 * 十二步链（ADR-0055）里有两类步骤：**判定**与**记录**。判定必须一模一样——
 * 模型直接调 `fs.write` 和程序在 `run_code` 里调 `fs.write`，网关、主张完备性、
 * 红线求值必须是同一份代码走过一遍，不能有第二条快路径（ADR-0061 §后果 最后一条）。
 * 而记录必须不一样：模型的调用要落 `tool.start` / `tool.end`，因为模型下一轮要看见结果；
 * 程序的子调用**不能**落它们，因为程序的中间值不进模型请求（ADR-0061 §四）。
 *
 * 于是链条参数化在这一个接口上：换掉 sink，换掉的只有"写什么事件"。
 * 判定那一半连一个分支都没有——这不是自觉，是它压根没有可分岔的地方。
 *
 * ── 谁在什么时候调 ──
 *
 * · `fail`  —— 前七步任一步失败（工具没找到、入参没过、网关拒绝、红线拒绝）。
 *              `prepared` 缺席表示"连准备都没走完"。
 * · `start` —— 判定通过，正要进工具体。
 * · `progress` / `end` —— 工具体的产出。
 *
 * `fail` 与 `end` 互斥，且一次调用**必有其一**——事件的成对性由此保证。
 */
export interface CallSink {
  fail(error: XmError, prepared?: PreparedCall): Promise<void>;
  start(prepared: PreparedCall): Promise<void>;
  progress(update: {
    readonly message?: string | undefined;
    readonly data?: unknown;
  }): Promise<void>;
  end(prepared: PreparedCall, result: ToolExecutionResult, durationMs: number): Promise<void>;
}

/**
 * 模型发起的调用：落 `tool.start` / `tool.progress` / `tool.end`。
 *
 * 这就是 M3-h 之前 `turn-tools.ts` 里内联的那三段 `record()`，一个字段没改。
 */
export const modelCallSink = (deps: TurnDeps, turnId: TurnId, call: PendingCall): CallSink => ({
  async fail(error) {
    await deps.runtime.record({
      type: 'tool.end',
      turnId,
      payload: {
        callId: call.callId,
        ok: false,
        durationMs: 0,
        forModel: [{ type: 'text', text: error.message }],
        error,
      },
    });
  },

  async start(prepared) {
    const origin = deps.callOrigins?.get(call.callId);
    await deps.runtime.record({
      type: 'tool.start',
      turnId,
      payload: {
        callId: call.callId,
        messageId: deps.runtime.ids.message(),
        name: call.name,
        input: prepared.input,
        risk: prepared.tool.descriptor.risk,
        capabilities: [...new Set(prepared.claims.map((claim) => claim.capability))],
        ...(origin === undefined ? {} : { origin }), // 谁发起的这次调用，缺席即模型（ADR-0065 §四）
      },
    });
  },

  async progress(update) {
    await deps.runtime.record({
      type: 'tool.progress',
      turnId,
      payload: {
        callId: call.callId,
        ...(update.message === undefined ? {} : { message: update.message }),
        ...(update.data === undefined ? {} : { data: update.data }),
      },
    });
  },

  async end(prepared, result, durationMs) {
    // 展示事实过工具自己的 schema 再落库；没声明 schema 或校验不过就不落（ADR-0058）
    const presentation = prepared.tool.parsePresentation(result.presentation);
    await deps.runtime.record({
      type: 'tool.end',
      turnId,
      payload: {
        callId: call.callId,
        ok: result.error === undefined,
        durationMs,
        forModel: [...result.forModel],
        ...(result.fullRef === undefined ? {} : { fullRef: result.fullRef }),
        ...(presentation === undefined ? {} : { presentation }),
        ...(result.error === undefined ? {} : { error: result.error }),
      },
    });
  },
});
