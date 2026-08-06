import type { XmError } from '@xm/contracts';
import { xmError } from '@xm/contracts';
import type { RegisteredTool, ToolContext } from '../tool/types.js';

/**
 * 能力网关 —— **判定看到的那个值，必须就是执行用的那个值**。
 *
 * ── 它要解决的问题 ──
 *
 * `PolicyEngine` 是纯函数，只做词法规范化：`/a/../b` → `/b`、盘符大写、去尾斜杠。
 * 做不了的它明确地拒绝（相对路径、未展开的 `~`、Windows 8.3 短名），因为那些都要
 * 问文件系统，而内核零 I/O。ADR-0012 与 ADR-0018 两次把这一半推给"运行时的能力网关"，
 * 而在 M1-c 之前**那个网关不存在**——两份 ADR 里的分工，只有一半有实现。
 *
 * 另一半具体是什么：
 *
 *   · **符号链接。** 工作区里一个指向 `~/.ssh/id_rsa` 的链接，词法规范化看到的是
 *     工作区内的那个路径，判定于是完全合规地放行了。
 *   · **相对路径。** 模型给的 `src/a.ts` 会被内核判成"判不了"直接 deny——行为是安全的，
 *     但用户撞到的是一个他自己解决不了的拒绝。
 *   · **Windows 8.3 短名。** `C:/PROGRA~1/x` 与 `C:/Program Files/x` 是同一个文件的
 *     两种写法，红线按长名写、请求按短名来就匹配不上。
 *
 * ── 为什么它必须**回写入参**，而不只是"算个 target 出来" ──
 *
 * 如果判定用解析后的路径、执行用原始入参，两者就是两个东西——那是权限判定上的
 * TOCTOU，和 `turn.ts` 里"先 parseInput 再判权"要防的是同一件事（那里防的是
 * `.default()` 让原始 JSON 与校验后的值分叉）。所以网关返回的 `input`
 * **就是**接下来交给 `execute()` 的那一个。
 *
 * ── 它只管解析，不管放行 ──
 *
 * 工作区边界、敏感目录、能不能写，一律仍由 `evaluate()` 的规则决定。
 * "闸门 1 是纯函数、安全逻辑绝不散落在各个工具里"（docs/06 §2）——
 * 网关一旦开始自己判 allow/deny，那条纪律就破了，而且破得很难发现：
 * 两处判定会慢慢分叉，谁也说不清最终生效的是哪一份。
 */
export interface ToolGateway {
  /**
   * 解析一次调用。
   *
   * **失败必须抛**（`GatewayError`）——返回一个"没解析成功但你凑合用"的值，
   * 就等于把失败关闭悄悄改成了失败放行。
   */
  resolve(tool: RegisteredTool, input: unknown, ctx: ToolContext): Promise<ResolvedCall>;
}

export interface ResolvedCall {
  /** 回写后的入参。**判定与执行共用它**，不是两份 */
  readonly input: unknown;
  /** 判权用的 target。路径类能力下它已经是绝对的、realpath 过的 */
  readonly target: string;
}

/** 网关解析不了这次调用。转成 `tool.end{ok:false}` 回灌给模型，不产生权限事件 */
export class GatewayError extends Error {
  readonly asXmError: XmError;

  constructor(message: string, detail?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'GatewayError';
    this.asXmError = xmError('invalid_input', message, {
      retryable: false,
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

/**
 * 零 I/O 的参考实现：只从入参里取出 target，不做任何解析。
 *
 * 用在 headless 冒烟与内核用例里——那些地方的工具本来就不碰文件系统，
 * 需要的只是"闸门长在调用路径上"这一点。
 *
 * ⚠️ **不要在真实工具上用它。** 它拿到相对路径会原样交给 `evaluate()`，
 * 而那里会失败关闭地 deny；拿到符号链接则完全看不出来。
 */
export const pureGateway = (
  targetOf: (toolName: string, input: unknown) => string,
): ToolGateway => ({
  resolve: (tool, input) =>
    Promise.resolve({ input, target: targetOf(tool.descriptor.name, input) }),
});
