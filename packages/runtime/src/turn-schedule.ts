import type { ResourceClaim } from '@xm/contracts';
import { parseToolArgs } from './turn-args.js';
import { turnAvailabilityContext } from './turn-request.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

/**
 * 一次模型回复里那几个工具调用，怎么排（ADR-0082，收窄 ADR-0005）。
 *
 * ── 在此之前，这里什么都没有 ──
 *
 * ADR-0005 定下了"混合式资源声明 + 冲突检测调度"，`ToolSpec.resources()` 与
 * `ToolDescriptor.concurrency` 也确实一路做到了工具定义里（`fs.read` 声明
 * `path/read`，`git.*` 声明一把 `global` 锁……）。**但调度器从来没有被写出来**：
 * 驱动器一直是 `for (const call of calls) await dispatch(call)`。
 * 于是"读 5 个文件"要串 5 次工具执行，而声明它们全是只读的那些代码只是注释。
 *
 * ── 为什么只并行只读，不并行写 ──
 *
 * ADR-0005 想要的是"改不同文件的两次 `edit` 也能并行"，判据是路径冲突检测。
 * 做不到，而且不是工程量的问题：`resources()` 拿到的是**网关规范化之前**的入参
 * （相对路径、符号链接、Windows 短名都还没解析——那些发生在 `prepareCall` 里，
 * 也就是排班之后）。`./a.ts` 与 `/work/a.ts` 在这一层看不出是同一个文件，
 * 于是"冲突检测"会漏判，而漏判一次的代价是并发写坏同一个文件。
 *
 * ADR-0005 自己写着那句判据：**并发的收益是省时间，并发出错的代价是数据损坏，
 * 两者不对称。** 按这句话办，就只能并行那些"无论怎么排都不会互相影响"的调用：
 *
 *   · `concurrency: 'parallel'`（工具作者自己声明的），**并且**
 *   · 它声明的资源里没有 `write`、没有 `global`、没有 `pty`。
 *
 * 一条 `write` 声明就让这次调用独占一批——不去猜它写的到底是不是同一个文件。
 * 没有任何资源声明的 `parallel` 工具（`web.fetch`、`index.search`）算并行安全：
 * `parallel` 本来就是工具作者在 ADR-0005 的接口上做的那个声明。
 */

/** 一批里最多同时跑几个。ADR-0005 定的默认上限 */
export const MAX_PARALLEL_CALLS = 8;

/**
 * 把调用切成一串**顺序执行的批次**；批次内部并发。
 *
 * 顺序在批次之间是保住的：模型给出的先后关系只在"并行安全"的连续段内被打散，
 * 而那一段里的调用按定义互不影响。一次写、一次 `shell.exec`、一次 `run_code`
 * 都独占自己的批次，前后的界仍然是模型给的那个顺序。
 */
export function planCallBatches(
  deps: TurnDeps,
  calls: readonly PendingCall[],
): readonly (readonly PendingCall[])[] {
  const batches: PendingCall[][] = [];
  let current: PendingCall[] = [];
  const flush = (): void => {
    if (current.length > 0) batches.push(current);
    current = [];
  };

  for (const call of calls) {
    if (!parallelSafe(deps, call)) {
      flush();
      batches.push([call]);
      continue;
    }
    current.push(call);
    if (current.length >= MAX_PARALLEL_CALLS) flush();
  }
  flush();
  return batches;
}

/**
 * 这次调用能不能与同批的别人一起跑。
 *
 * **任何拿不准的情况都退回独占**：工具查不到、入参解不开、`resources()` 抛异常。
 * 这不是防御性编程的装饰——判不了就串行，只损失时间；判错了就并发，可能损失数据。
 */
function parallelSafe(deps: TurnDeps, call: PendingCall): boolean {
  const availability = turnAvailabilityContext(deps);
  const tool =
    availability === undefined ? deps.tools.get(call.name) : deps.tools.getAvailable(call.name, availability);
  if (tool === undefined) return false;
  if (tool.descriptor.concurrency !== 'parallel') return false;

  const args = parseToolArgs(call.argsJson);
  if (!args.ok) return false;

  let claims: readonly ResourceClaim[];
  try {
    // `resources()` 会先按 schema 解一遍入参——解不开就抛，那时同样退回独占
    claims = tool.resources(args.value);
  } catch {
    return false;
  }
  return claims.every(harmless);
}

/** 无论和谁一起跑都不会互相影响的资源声明 */
const harmless = (claim: ResourceClaim): boolean =>
  claim.kind === 'net' || (claim.kind === 'path' && claim.mode === 'read');
