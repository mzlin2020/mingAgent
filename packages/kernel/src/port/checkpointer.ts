import type { BlobRef, CheckpointManifestV2 } from '@xm/contracts';
import type { AbortLike, RegisteredTool, ToolContext } from '../tool/types.js';
import type { PermissionClaim } from './tool-gateway.js';

/**
 * 还原点端口（ADR-0003「平衡档 + **无条件**还原点」的执行点）。
 *
 * ── 为什么它在运行时，不在工具里 ──
 *
 * 直觉上"谁改文件谁负责建还原点"更内聚。但工具**够不着事件流**——`ToolContext` 里
 * 没有记录事件的入口，那是 ADR-0019 刻意留下的结构性约束（否则工具就能自己发
 * `trust.cleared`）。更要紧的是：一条"每个破坏性工具自己记得建还原点"的约定，
 * 迟早会被某个新工具漏掉，而漏掉的表现是"平时都能撤销，唯独这次不能"。
 *
 * 所以还原点由 Turn 循环在**执行之前**统一建立，判据来自工具的自描述
 * （`capabilities` 含 `fs.write` / `fs.delete`，且声明了 `pathInputs`）——
 * 与权限判定用的是同一份声明，不需要第二处名单。
 *
 * ── 为什么结果同时带 record 与 warnings ──
 *
 * "没有需要快照的东西"是正常结果；尚未支持的目标类型允许继续但必须告警。
 * 真正的 I/O 失败直接 reject，由运行时停止破坏性操作。
 */
export interface Checkpointer {
  /**
   * 在工具执行**之前**建立还原点。
   *
   * 抛错意味着本应建立的还原点因 I/O/完整性问题失败，调用方必须停止执行。
   * 已知不支持的目标类型通过 warnings 表达，调用方告警后继续。
   */
  before(
    tool: RegisteredTool,
    input: unknown,
    ctx: ToolContext,
    /**
     * 这次调用的全部主张（ADR-0026）。判据从"工具声明了 `fs.write` 且有 `pathInputs`"
     * 变成"主张里有 `fs.write` / `fs.delete` 的具体路径"——否则 `rm foo.txt` 这类
     * 经由 `shell.exec` 发生的删除**一个还原点都没有**，而 ADR-0003 承诺的是
     * "平衡档 + **无条件**还原点"。判据仍然与权限判定同源，只是同源的那份东西
     * 从能力声明换成了主张。
     */
    claims: readonly PermissionClaim[],
  ): Promise<CheckpointBeforeResult | undefined>;
}

export interface CheckpointBeforeResult {
  /** 至少有一个真实可恢复对象时才存在。 */
  readonly record?: CheckpointRecord;
  /** 已知无法快照但允许继续的目标；M2-c 完成后文件与目录都不应走这里。 */
  readonly warnings: readonly string[];
}

export interface CheckpointRecord {
  readonly kind: 'fs' | 'git';
  /** blob 引用串或 git 快照 sha。回退时据此还原 */
  readonly ref: string;
  /** v2 结构化恢复计划。fs checkpoint 从 M2-c 起必须提供。 */
  readonly manifestRef?: BlobRef;
  /** 给用户看的一句话，如「写入 README.md 之前」 */
  readonly label: string;
}

export interface CheckpointRestorer {
  /** 读取并完整校验 manifest，供详情入口展示。 */
  inspect(ref: BlobRef): Promise<CheckpointManifestV2>;
  /** 把所有目标收敛到 manifest 描述的状态；实现必须可安全重试。 */
  restore(ref: BlobRef, signal?: AbortLike): Promise<void>;
}
