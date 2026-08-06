import { realpath as realpathCb } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isPathCapability } from '@xm/contracts';
import type { RegisteredTool, ResolvedCall, ToolContext, ToolGateway } from '@xm/kernel';
import { GatewayError, normalizePathTarget } from '@xm/kernel';

/**
 * **必须是 `.native`。**
 *
 * `fs.promises.realpath` 是 JS 实现，它解符号链接，但**解不了 Windows 的 8.3 短名**——
 * 而 ADR-0024 关闭 ADR-0018 遗留时写的正是"realpath.native 顺带把短名展开成长名"。
 * 文档里写着 `.native`、代码里用的是另一个，这条遗留就只是看起来被关掉了。
 * （`fs/promises` 上没有 `.native`，所以从回调版 promisify 过来。）
 */
const realpath = promisify(realpathCb.native);

/**
 * 路径能力网关的 Node 实现（ADR-0024）。
 *
 * 做四件事，每一件都是内核做不了的（它零 I/O）：
 *
 *   一、**相对 → 绝对**，基准是会话的 `cwd`。
 *   二、**realpath**：符号链接、`.`/`..`、以及 Windows 8.3 短名一并解析掉。
 *   三、**回写入参**：解析后的路径写回 `input`，判定与执行因此共用同一个字符串。
 *   四、**声明缺失就拒绝**：声明了路径类能力却没声明 `pathInputs`，当场失败关闭。
 *
 * ── 不存在的文件怎么办 ──
 *
 * `fs.write` 的目标经常还不存在，而 `realpath` 对不存在的路径直接抛 ENOENT。
 * 所以这里的做法是**逐级向上找到最深的存在祖先，realpath 它，再把剩下的段拼回去**。
 * 这不是权宜之计：符号链接逃逸的载体一定是某个**已经存在**的目录段，
 * 而那一段必然在这个祖先里。把 `/work/link-to-etc/x.txt` 解析成
 * `/etc/x.txt` 靠的正是这一步。
 *
 * ── 剩下的那个窗口，得说清楚 ──
 *
 * 解析完到工具真正 open 之间仍有时间差：中途把某一段换成符号链接，判定就落在旧目标上。
 * 这个窗口关不掉——**关它需要在打开的文件描述符上判定**，而那要么改成"网关自己打开文件、
 * 把 fd 交给工具"，要么依赖执行器沙箱（docs/09 C2，M1-d 前定案）。
 * 现在的姿态是：把窗口从"整条路径随便换"缩到"要在毫秒级里抢",并如实记在这里，
 * 而不是假装它不存在。
 */

export interface NodeGatewayOptions {
  /**
   * 覆盖 `ToolContext.cwd`。省略则用上下文里的——那才是常态，
   * 每个会话有自己的工作目录。
   */
  readonly cwd?: string;
}

export const nodeToolGateway = (options: NodeGatewayOptions = {}): ToolGateway => ({
  async resolve(tool: RegisteredTool, input: unknown, ctx: ToolContext): Promise<ResolvedCall> {
    const needsPath = tool.descriptor.capabilities.some(isPathCapability);

    if (tool.pathInputs.length === 0) {
      /*
       * 声明了路径类能力却没有 `pathInputs`——**拒绝，不放行**。
       *
       * 放行的后果是这次调用的 target 是空字符串，于是它只被能力级规则判定，
       * 所有基于路径的规则（包括红线）全部匹配不上。那是一个安静的整体绕过，
       * 而它的起因只是有人加工具时漏写了一个字段。
       */
      if (needsPath) {
        throw new GatewayError(
          `工具 ${tool.descriptor.name} 声明了路径类能力，却没有声明 pathInputs——` +
            `网关无法知道哪个入参是路径，也就判不出这次操作动的是哪个文件。` +
            `这会让所有基于路径的规则（含红线）匹配不上，因此直接拒绝。`,
          { tool: tool.descriptor.name },
        );
      }
      return { input, target: '' };
    }

    const cwd = options.cwd ?? ctx.cwd;
    if (!isAbsolute(cwd)) {
      throw new GatewayError(
        `会话的工作目录 "${cwd}" 不是绝对路径，无法据此解析相对路径。`,
        { cwd },
      );
    }

    const record = asRecord(input, tool.descriptor.name);
    const out: Record<string, unknown> = { ...record };
    let target = '';

    for (const field of tool.pathInputs) {
      const raw = record[field];
      // 可选的路径字段没给值就跳过——它不是错误，只是这次调用没用到
      if (raw === undefined) continue;
      if (typeof raw !== 'string' || raw === '') {
        throw new GatewayError(
          `工具 ${tool.descriptor.name} 的入参 "${field}" 应当是一个非空路径字符串。`,
          { tool: tool.descriptor.name, field },
        );
      }

      const resolved = canonical(await resolveDeep(resolve(cwd, raw)), tool.descriptor.name, field);
      out[field] = resolved;
      // 第一个声明的字段就是判权用的 target（`pathInputs` 按判权重要性排序）
      if (target === '') target = resolved;
    }

    return { input: out, target };
  },
});

/**
 * 把 realpath 出来的**平台原生**路径，变成内核判定用的那个坐标系里的字符串。
 *
 * ── 为什么不是"算出 target 就够了" ──
 *
 * ADR-0024 的要害是"判定看到的那个路径，必须就是工具打开的那个路径"。
 * 而 `evaluate()` 拿到 target 之后还会再规范化一次（正斜杠、盘符大写）。
 * 于是在 Windows 上，如果这里回写的是 `C:\work\a.md` 而判定比的是 `C:/work/a.md`，
 * 事件流里记的、授权里存的、规则里写的就又变成了三个不同的字符串——
 * 「本会话都允许」下一次照样弹框，而没有任何地方看得出为什么。
 *
 * 所以这里就把它归到最终形态：**入参、target、事件、授权，从这一行起是同一个串**。
 * Node 的 fs API 在 Windows 上一律接受正斜杠，所以回写正斜杠不影响任何工具。
 * POSIX 上这一步是恒等变换——它改变的只有 Windows 的行为。
 *
 * `\\?\` 前缀（长路径形态，`realpath.native` 在某些卷上会返回它）必须先摘掉：
 * 内核会把它当成一个以 `/` 开头的 POSIX 路径，规范化成 `/?/C:/...`，那是个匹配不上
 * 任何规则的怪串——**一条静默失效的红线，比一条报错的红线危险得多**。
 */
function canonical(nativePath: string, tool: string, field: string): string {
  const stripped = nativePath.replace(/^\\\\\?\\(UNC\\)?/, (_m, unc: string | undefined) =>
    unc === undefined ? '' : '\\\\',
  );

  /*
   * UNC（`\\server\share\...`）**当场拒绝**，不是"尽力而为"。
   *
   * 内核的归一没有 UNC 契约：`\\server\share\x` 会被当成一个以 `/` 开头的 POSIX 路径，
   * 归一成 `/server/share/x`。那个串有两个问题，每个单独都足以拒绝——
   *   · 拿它去执行，Windows 会解析成**当前盘的根目录**下，与用户说的不是一个地方；
   *   · 拿它去判定，它和一条写给 POSIX 的 `/server/**` 规则形状完全相同。
   *
   * 与 8.3 短名同一个处置：判不了就明确地判不了，不给一层看起来能用的假防线。
   */
  if (/^[\\/]{2}/.test(stripped)) {
    throw new GatewayError(
      `工具 ${tool} 的入参 "${field}" 指向一个 UNC 网络路径（${nativePath}）。` +
        `路径归一还没有 UNC 契约，判定会落在错误的坐标系上，因此这里直接拒绝。`,
      { tool, field, path: nativePath },
    );
  }

  const normalized = normalizePathTarget(stripped);
  if (!normalized.ok) {
    throw new GatewayError(
      `工具 ${tool} 的入参 "${field}" 解析出的路径 "${nativePath}" 无法规范化：` +
        normalized.reason,
      { tool, field, path: nativePath },
    );
  }
  return normalized.value;
}

/**
 * realpath 一个可能还不存在的路径。
 *
 * 向上找到最深的存在祖先并解析它，再把剩余段原样拼回去。
 * 每一段都不做任何"聪明"的处理——`..` 在这里已经被 `resolve()` 消解过，
 * 而剩余段按定义是不存在的，没有链接可解。
 */
async function resolveDeep(absolute: string): Promise<string> {
  const rest: string[] = [];
  let cursor = absolute;

  for (;;) {
    try {
      const real = await realpath(cursor);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) {
        /*
         * 走到了根还是解析不了。这在正常的文件系统上几乎不可能发生
         * （根一定存在），所以它更可能意味着权限问题或路径畸形——
         * 无论哪种，**都不是可以按未解析路径继续判定的理由**。
         */
        throw new GatewayError(`无法解析路径 "${absolute}"：向上到根都不存在或不可访问。`, {
          path: absolute,
        });
      }
      rest.push(cursor.slice(parent.length).replaceAll(sep, ''));
      cursor = parent;
    }
  }
}

function asRecord(input: unknown, toolName: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GatewayError(`工具 ${toolName} 的入参不是一个对象，无法从中取出路径字段。`, {
      tool: toolName,
    });
  }
  return input as Record<string, unknown>;
}
