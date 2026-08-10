import type { Capability, XmError } from '@xm/contracts';
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
  /**
   * 判权用的全部主张。见 `PermissionClaim`。
   *
   * 这里以前还有一个 `target: string`——"这次调用作用在哪"。它被 `claims` 整个取代了：
   * 一次调用不只作用在一个地方，而留一个没人读的字段，就是这个仓库反复记过的
   * "契约写好了、没有任何调用点"。
   */
  readonly claims: readonly PermissionClaim[];
  /**
   * 网络侧"判定与执行必须共用同一个值"的载体（M1-d）。路径侧靠回写 `input` 做到这件事，
   * 网络侧做不了——URL 字符串本身不能被网关改写成解析出的 IP（会破坏 Host header/SNI
   * 语义），所以只能走这条带外通道：键是归一后的裸主机名，值是网关那次 DNS 查询解析出的
   * 地址。`turn.ts` 把它合并进 `ToolContext.pinnedHosts`，工具执行时只能用这张表建连，
   * 不能自己再解析一次——见 `ToolContext.pinnedHosts` 的注释。
   */
  readonly pinnedHosts?: ReadonlyMap<string, { readonly address: string; readonly family: 4 | 6 }>;
}

/**
 * 一次调用要过的一条闸门：**这个能力，作用在这个目标上**。
 *
 * ── 为什么不是"能力列表 + 一个 target" ──
 *
 * 那是这个字段出现之前的形状：`turn.ts` 遍历工具声明的每个能力，全都拿同一个 target 去判。
 * 对 `fs.read`、`fs.write` 这种"一个工具动一个文件"的工具，两者等价。
 * 但它让 `shell.exec` 完全没法判——一条 `rm -rf ~` 只能以
 * 「能力 `shell.exec`、目标 那条命令行」的形式过闸门，命中 `def.shell-exec` 的 ask，
 * 而挂在 `fs.delete` 上的红线压根不会被查（ADR-0026 背景）。
 *
 * 拆成主张之后，一条命令可以同时是「执行一条命令」和「删除 `/home/ming`」，
 * 后者撞的是一条 M0 就写好的红线。**红线按目标写、不按调用方自称在做什么写**
 * （ADR-0014 的那半个教训）在这里第三次被用上。
 *
 * ⚠️ 主张**只能加不能减**：它必须覆盖工具静态声明的每一个能力，
 * 否则一个工具就能靠"少声明一条主张"绕开自己的能力声明。`turn.ts` 有断言钉着。
 */
export interface PermissionClaim {
  readonly capability: Capability;
  readonly target: string;
  /**
   * 这条主张**只用来查 deny，不拿去问用户**（ADR-0036）。
   *
   * 唯一的用例是网络类主张里那条"解析出的 IP"（`resolveHost` 的 claim B）：它存在
   * 是为了让 SSRF 的 IP 段规则有东西可匹配——判定与建连必须看同一个地址，否则就是
   * DNS 重绑定的窗口（ADR-0028）。但它同时也匹配上了 `def.net-fetch` 的 ask，
   * 于是**每一次 `web.fetch` 都弹两个框**：一个写着域名，一个写着用户根本无从判断的
   * 裸 IP。实测确认过，这是审批噪音的第二个来源，和 ADR-0035 修的那个乘在一起。
   *
   * 那第二个框换不来任何安全：用户能做的判断全在域名那一个框里，
   * 而针对 IP 的授权也不会泛化到任何别处。所以这里的语义是——
   * **`deny` 照旧拦（那才是它的用途），`ask` 视为已满足，不进待问队列。**
   *
   * 缺省 `false`：只有明确知道自己是"检查用"的主张才配得上这个标记，
   * 忘了标的后果是多问一次，不是少拦一次。
   */
  readonly checkOnly?: boolean;
}

/**
 * 「工具声明的每个能力 × 同一个 target」—— 路径类工具的主张形状，也是默认形状。
 *
 * 网关没给主张时由 `turn.ts` 兜底合成，从而"没有网关"与"零 I/O 网关"这两条路
 * 与今天的行为完全一致。
 */
export const claimsOfCapabilities = (
  capabilities: readonly Capability[],
  target: string,
): readonly PermissionClaim[] => capabilities.map((capability) => ({ capability, target }));

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
  resolve(tool, input) {
    const target = targetOf(tool.descriptor.name, input);
    return Promise.resolve({
      input,
      claims: claimsOfCapabilities(tool.descriptor.capabilities, target),
    });
  },
});
