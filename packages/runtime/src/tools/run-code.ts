import { z } from 'zod';
import type { ResultBlock, ToolCard, ToolProgress } from '@xm/contracts';
import type { CodeRuntimeResult, RegisteredTool, ToolContext } from '@xm/kernel';
import { defineTool } from '@xm/kernel';
import { RUN_CODE } from '../code-sdk.js';

/**
 * Code Mode 的唯一入口（ADR-0061）。
 *
 * 模型写一段 TypeScript，一次调用里连做多步——读三个文件、改一处、跑一次测试，
 * 从五六次往返压成一次。省下的不只是延迟：每一次往返都要重发整个上下文。
 *
 * ── 三条边界，都在别处兑现，这里只是把它们用起来 ──
 *
 * · 程序**拿不到**宿主能力：客体域里没有 `require` / `process` / `fetch`（ADR-0069）。
 * · 程序调工具**重走完整十二步链**：父调用被允许不代表子调用被允许（`turn-code.ts`）。
 * · 程序的**中间值不进模型请求**：只有 `return` 的值与 `console.log` 越过这条边界，
 *   而它们受既有的结果截断管辖（ADR-0009）。这正是"读十个文件只回传摘要"能成立的原因。
 */

const Input = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(64_000)
    .describe(
      '一段 TypeScript 函数体。同步执行：不要写 await、不要写 import；' +
        '用 return 交回最终结果。工具经 xm.<分组>.<名字>(入参) 调用。',
    ),
});

/**
 * 规范输出值（ADR-0071）。
 *
 * `value` 是**JSON 文本**而不是结构：程序能 return 任何形状，而规范值的 schema 必须
 * 落在可序列化子集里（`z.unknown()` 是被禁的——它等于没有约束）。用文本 + `hasValue`
 * 把"返回了 null"与"什么都没返回"分开，程序侧一次 `JSON.parse` 就还原。
 */
const Output = z.strictObject({
  ok: z.boolean(),
  hasValue: z.boolean(),
  /** 程序返回值的 JSON 文本；`hasValue` 为 false 时是空串 */
  value: z.string(),
  logs: z.array(z.string()),
  /** 日志或返回值被预算截断过 */
  clipped: z.boolean(),
  calls: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      name: z.string(),
      ok: z.boolean(),
      message: z.string().optional(),
    }),
  ),
  error: z
    .strictObject({
      kind: z.enum(['compile', 'throw', 'timeout', 'cpu', 'memory', 'aborted', 'substrate', 'unavailable']),
      message: z.string(),
    })
    .optional(),
});

/** 回放期的最小事实（ADR-0058）。**程序全文不在这里**——它已经在 `tool.start.input` 里了 */
const Presentation = z.strictObject({
  ok: z.boolean(),
  runtime: z.string(),
  logs: z.number().int().nonnegative(),
  calls: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      name: z.string(),
      ok: z.boolean(),
      message: z.string().optional(),
    }),
  ),
  errorKind: z.string().optional(),
});
type Presentation = z.infer<typeof Presentation>;

export const runCodeTool = (): RegisteredTool =>
  defineTool({
    name: RUN_CODE,
    group: 'code',
    description:
      '运行一段 TypeScript，在一次调用里连做多步工具操作。程序里每次工具调用都照常判权，' +
      '被拒绝会抛异常。只有 return 的值和 console.log 的内容会回传给你。',
    inputSchema: Input,
    /*
     * `risk: 'medium'`、`capabilities: []`。
     *
     * 这不是"跑任意代码只算中危"——**这次调用自己什么也不碰**：它不开文件、不起进程、
     * 不发网络。真正动东西的是程序里的每一次子调用，而那些各自带着自己的 risk 与能力，
     * 各自判各自的。把父调用标成 high 并挂上一堆能力，只会让红线在错误的一层生效
     * （ADR-0017 的教训是反过来的同一件事：红线要按目标写，不按调用方自称在做什么写）。
     */
    risk: 'medium',
    capabilities: [],
    concurrency: 'exclusive',
    outputSchema: Output,
    presentationSchema: Presentation,

    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const seam = ctx.codeMode;
      if (seam === undefined) {
        yield unavailable();
        return;
      }
      yield { kind: 'progress', message: '程序运行中…' };

      const outcome = await seam.runtime.run({
        source: input.source,
        bindings: seam.bindings(),
        // 运行域由提供者给：程序被终止时它 abort，在途子调用跟着停（C2）
        call: (request, runSignal) => seam.dispatch(request, runSignal),
        nowMs: seam.now(),
        randomSeed: seam.randomSeed(),
        signal: ctx.signal,
      });

      /*
       * 子调用清单取自接缝的账本，**不是工具自己数的**。事件里的 index 与卡片上的序号
       * 因此是同一个计数器——两个各数各的迟早会错开一位，而那种错位在界面上看不出来。
       */
      const calls = seam.dispatched().map((record) => ({
        index: record.index,
        name: record.name,
        ok: record.ok,
        ...(record.message === undefined ? {} : { message: record.message }),
      }));
      const encoded = encodeValue(outcome.value);

      yield {
        kind: 'result',
        forModel: [{ type: 'text', text: narrate(outcome, calls, encoded) } satisfies ResultBlock],
        presentation: {
          ok: outcome.ok,
          runtime: seam.runtime.kind,
          logs: outcome.logs.length,
          calls,
          ...(outcome.error === undefined ? {} : { errorKind: outcome.error.kind }),
        } satisfies Presentation,
        output: {
          ok: outcome.ok,
          hasValue: encoded !== undefined,
          value: encoded ?? '',
          logs: [...outcome.logs],
          clipped: outcome.clipped,
          calls,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        },
      };
    },

    presentCall: (input) => ({
      kind: 'generic',
      summary: `运行一段程序（${String(input.source.split('\n').length)} 行）`,
      title: '程序运行中…',
    }),
    presentResult: (_input, result) => resultCard(result.presentation, result.ok),
  });

type CallRecord = Presentation['calls'][number];

/** 程序返回值 → JSON 文本。跨不了 JSON 的东西在提供者那一层就已经拦掉了 */
function encodeValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json : undefined;
}

/**
 * 给模型看的那份散文。
 *
 * 拒绝过的子调用**逐条列出来**：程序完全可以 catch 掉一次拒绝继续跑完，那时模型只看
 * 返回值的话，会以为一切正常——而实际上有一步没做成。这条与"审计里必有那条
 * `tool.code.dispatch`"是同一件事的两侧（ADR-0061 后果段第三条）。
 */
function narrate(
  outcome: CodeRuntimeResult,
  calls: readonly CallRecord[],
  encoded: string | undefined,
): string {
  const parts: string[] = [];
  parts.push(
    outcome.ok
      ? encoded === undefined
        ? '程序结束，没有 return 任何值。'
        : `程序结束。返回值：\n${encoded}`
      : `程序失败（${outcome.error?.kind ?? 'unknown'}）：${outcome.error?.message ?? '未知原因'}`,
  );
  const denied = calls.filter((call) => !call.ok);
  if (calls.length > 0) {
    parts.push(
      `共 ${String(calls.length)} 次工具调用` +
        (denied.length === 0 ? '，全部成功。' : `，其中 ${String(denied.length)} 次失败：`),
    );
    for (const call of denied) {
      parts.push(`  · 第 ${String(call.index + 1)} 步 ${call.name}：${call.message ?? '失败'}`);
    }
  }
  if (outcome.logs.length > 0) parts.push(`--- 程序日志 ---\n${outcome.logs.join('\n')}`);
  if (outcome.clipped) parts.push('（日志或返回值超过上限，已截断）');
  return parts.join('\n');
}

const unavailable = (): ToolProgress => ({
  kind: 'result',
  forModel: [
    {
      type: 'text',
      text: '这台机器没有装配 Code Mode 运行时，run_code 不可用。请逐个调用工具。',
    },
  ],
  output: {
    ok: false,
    hasValue: false,
    value: '',
    logs: [],
    clipped: false,
    calls: [],
    error: { kind: 'unavailable', message: '没有装配 Code Mode 运行时。' },
  },
});

/**
 * 完成卡片：**程序内的每一步都列出来**（ADR-0061 后果段第二条）。
 *
 * 卡片本身不重复程序全文——渲染层从这次调用的入参里就拿得到，而 `presentation`
 * 是要落库的，把源码再存一遍等于同一份内容存两份（ADR-0050 / ADR-0070 修过两次的形状）。
 *
 * 子调用清单写在 `body` 而不是 `locations`：后者的每一项都必须是一个文件路径，
 * 而"第 3 步 shell.exec"不是路径。硬塞进去只会让"点一下跳过去"变成一个坏掉的按钮。
 */
function resultCard(presentation: Presentation | undefined, ok: boolean): ToolCard | undefined {
  if (presentation === undefined) return undefined;
  const denied = presentation.calls.filter((call) => !call.ok).length;
  const steps = presentation.calls.map(
    (call) => `${String(call.index + 1)}. ${call.name}${call.ok ? '' : ` ✗ ${call.message ?? '失败'}`}`,
  );
  return {
    kind: 'generic',
    summary:
      (ok && presentation.ok ? '程序已运行' : `程序失败（${presentation.errorKind ?? '未知'}）`) +
      ` · ${String(presentation.calls.length)} 次工具调用` +
      (denied === 0 ? '' : `，${String(denied)} 次失败`) +
      (presentation.logs === 0 ? '' : ` · ${String(presentation.logs)} 行日志`),
    title: `run_code（${presentation.runtime}）`,
    ...(steps.length === 0 ? {} : { body: steps.join('\n') }),
  };
}

export type { ToolContext };
