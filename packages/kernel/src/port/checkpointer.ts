import type { RegisteredTool, ToolContext } from '../tool/types.js';
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
 * ── 为什么返回值可以是 undefined ──
 *
 * "没有需要快照的东西"是正常结果，不是失败：写一个还不存在的新文件、
 * 或者一个声明了 `fs.write` 却本次没碰到文件的调用。这时不该落一条指向空内容的
 * `checkpoint.created`——那会让还原点列表里全是噪音，真正能回退的那几个反而找不到。
 */
export interface Checkpointer {
  /**
   * 在工具执行**之前**建立还原点。
   *
   * 抛错意味着还原点建不起来。调用方（`turn.ts`）**不因此中止执行**，
   * 而是记一条 notice：一次快照失败不该让用户的任务停下，但他必须知道
   * "这一步没有退路"。这与"降级可以、不告诉用户不行"是同一条纪律。
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
  ): Promise<CheckpointRecord | undefined>;
}

export interface CheckpointRecord {
  readonly kind: 'fs' | 'git';
  /** blob 引用串或 git 快照 sha。回退时据此还原 */
  readonly ref: string;
  /** 给用户看的一句话，如「写入 README.md 之前」 */
  readonly label: string;
}
