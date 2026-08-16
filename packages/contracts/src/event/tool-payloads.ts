import { z } from 'zod';
import { BlobRef } from '../base/blob.js';
import { XmError } from '../base/error.js';
import { CallId, MessageId } from '../base/ids.js';
import { ResultBlock } from '../content/block.js';
import { Capability } from '../permission/capability.js';
import { RiskLevel } from '../tool/descriptor.js';
import { ToolCallOrigin } from '../tool/origin.js';

/**
 * 工具那一族事件的 payload。
 *
 * 从 `payloads.ts` 拆出来是规模纪律逼的（那个文件加上 `tool.code.dispatch` 之后越线），
 * 但拆得动是因为这四条自成一体：它们共用 `callId` 这条主线，且**只有它们**要回答
 * "这次调用做了什么、模型看到了什么、审计看得到什么"。
 *
 * 🔴 与 `payloads.ts` 一样：**一律 `z.looseObject()`**（原因见 envelope.ts 顶部）。
 */

export const ToolStartPayload = z.looseObject({
  callId: CallId,
  messageId: MessageId,
  name: z.string(),
  /** 已过启发式脱敏（shell 命令行可能含密钥）。尽力而为，不是保证 */
  input: z.unknown(),
  risk: RiskLevel,
  capabilities: z.array(Capability),
  /** 缺席按 `{ kind: 'model' }` 读——M3-f 之前的历史事件全都没有这个字段 */
  origin: ToolCallOrigin.optional(),
});

/** [T] 瞬态 */
export const ToolProgressPayload = z.looseObject({
  callId: CallId,
  message: z.string().optional(),
  data: z.unknown().optional(),
});

export const ToolEndPayload = z.looseObject({
  callId: CallId,
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /**
   * **已截断的原文，不是引用。**
   *
   * 回放上下文时必须逐字节还原当时喂给模型的内容——存引用会让"当时模型看到了什么"
   * 依赖 blob 表的存活状态。看起来冗余，但这是"可回放"这条原则能否成立的分水岭。
   */
  forModel: z.array(ResultBlock),
  /** 未截断全文（仅当发生截断时存在） */
  fullRef: BlobRef.optional(),
  /**
   * 回放需要的最小事实（ADR-0058）。**卡片本身不落库**——它是这份事实与调用入参的
   * 纯函数投影，实时流与回放各投影一次，结果必须一致。
   */
  presentation: z.unknown().optional(),
  error: XmError.optional(),
});

/**
 * Code Mode 里程序发起的一次子调用（ADR-0061 §一 / ADR-0072）。
 *
 * ── 它是子调用**唯一**的事件，不配 `tool.start` / `tool.end` ──
 *
 * 子调用走的是同一条十二步链，但它跨的边界不一样：模型没有发起它，模型也不该看见它的
 * 返回值。ADR-0061 §四 把"程序中间值不落库、不进提示词"定成了 Code Mode 省往返的
 * 前提——读十个文件只回传一句摘要，靠的就是那十份正文一次也没进过模型请求。
 *
 * 所以这里**没有 `forModel` 字段**，和 `output` 不进 `tool.end` 是同一个手法
 * （ADR-0071）：没有位置可放，就不必依赖谁记得别放。
 *
 * 留下的全是审计要回答"这次写文件是某段程序里的第三步"所必需的：谁的第几步、
 * 调了什么、动了哪些能力、成没成、失败原因。被拒的子调用照样落一条 `ok: false`——
 * **即使程序把那个异常 catch 掉继续跑**，审计里也看得见（ADR-0061 后果段第三条）。
 */
export const ToolCodeDispatchPayload = z.looseObject({
  /** 子调用自己的 callId。新分配的，不是父调用那一个 */
  callId: CallId,
  /** 发起这段程序的那次 `run_code` 调用 */
  parentCallId: CallId,
  /** 程序里的第几次调用，从 0 起算。它给的是顺序，`callId` 给的是身份 */
  index: z.number().int().nonnegative(),
  name: z.string(),
  /** 已过启发式脱敏，与 `tool.start.input` 同样处理 */
  input: z.unknown(),
  /**
   * 这两个**可缺席**，而 `tool.start` 里是必填。
   *
   * 差别来自这条事件覆盖的范围更宽：它连"根本没跑起来"的子调用也要记（工具名不存在、
   * 入参没过 schema、网关解析失败）。那种时候风险等级与能力清单还没有值——
   * 与其填一个 `'safe'` / `[]` 冒充"已知"，不如让它缺席。**缺席的意思是
   * "没走到能拿到它的那一步"，不是"没有风险"。**
   */
  risk: RiskLevel.optional(),
  capabilities: z.array(Capability).optional(),
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  error: XmError.optional(),
});
