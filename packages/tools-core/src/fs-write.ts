import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

export const FS_WRITE = 'fs.write';

/**
 * 写一个文本文件（全量覆盖）。
 *
 * ── 原子写 ──
 *
 * 写临时文件 → fsync → rename，与 `FileBlobStore` 同一手法。理由也相同：
 * 半截文件比没有文件糟糕得多。直接 `writeFile` 在进程被杀、磁盘满、或者用户
 * 正好点了停止的时候，会留下一个**看起来正常**的残缺文件——而这里写的经常是
 * 用户要接着编译、接着提交的东西。
 *
 * ── 还原点不在这里 ──
 *
 * 写之前的内容快照由运行时在执行前落（`checkpoint.ts` + `turn.ts`），
 * 不由工具自觉。工具够不着事件流（`ToolContext` 里没有记录事件的入口，这是刻意的），
 * 而且"每个破坏性工具自己记得建还原点"是一条迟早会被漏掉的约定。
 *
 * ── 全量覆盖，不做局部编辑 ──
 *
 * 局部编辑与 diff 审阅已由 M2-d/e 的 `edit.preview` / `edit.apply` 单独实现；本工具仍只负责
 * 明确的整文件写入，不在这里复刻编辑提案协议。
 * 现在提供一个"看起来能改一行"的接口，实际会变成模型反复整份重写还以为在做局部修改。
 */
const Input = z.strictObject({
  path: z.string().min(1).describe('要写入的文件路径'),
  content: z.string().describe('文件的完整新内容。这是全量覆盖，不是追加也不是局部替换'),
});

/**
 * 规范输出值（ADR-0071）。
 *
 * `kind` 把"写成了"与"没写"分开在结构里：`rejected` / `cancelled` 两种情况下
 * 这个工具**照常正常返回**（不抛），文本里说明原因。程序要能不读那句中文就知道
 * 盘上什么也没变——这正是散文与规范值分开的意义。
 */
const Output = z.strictObject({
  path: z.string(),
  kind: z.enum(['created', 'overwritten', 'rejected', 'cancelled']),
  /** 打算写入的字节数；`rejected` 时是被拒的那个体积，`cancelled` 时同样是未写入的体积 */
  bytes: z.number().int(),
});

/** 单次写入上限。模型一次吐出超过这个量，多半是它自己出了问题 */
const MAX_BYTES = 5 * 1024 * 1024;

export const fsWriteTool = (): RegisteredTool =>
  defineTool({
    name: FS_WRITE,
    group: 'fs',
    description: '把内容写入文件（全量覆盖，不存在则创建）。父目录会自动创建。',
    inputSchema: Input,
    risk: 'medium',
    capabilities: ['fs.write'],
    concurrency: 'parallel',
    pathInputs: ['path'],
    resources: (input) => [{ kind: 'path', mode: 'write', glob: input.path }],
    outputSchema: Output,

    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const bytes = Buffer.byteLength(input.content, 'utf8');
      if (bytes > MAX_BYTES) {
        yield {
          kind: 'result',
          forModel: [
            {
              type: 'text',
              text: `拒绝写入：${String(bytes)} 字节超过单次上限 ${String(MAX_BYTES)} 字节。`,
            },
          ],
          output: { path: input.path, kind: 'rejected', bytes },
        };
        return;
      }

      const existed = await exists(ctx.executor.fs, input.path);
      yield { kind: 'progress', message: existed ? `覆盖 ${input.path}` : `新建 ${input.path}` };

      // 取消检查放在真正动手之前。之后就不再检查了——一次 rename 中途"停下来"
      // 只会留下临时文件，而那比写完更难收拾
      if (ctx.signal.aborted) {
        yield {
          kind: 'result',
          forModel: [{ type: 'text', text: '已取消，没有写入。' }],
          output: { path: input.path, kind: 'cancelled', bytes },
        };
        return;
      }

      await ctx.executor.fs.writeTextAtomic(input.path, input.content);

      yield {
        kind: 'result',
        forModel: [
          {
            type: 'text',
            text: `已${existed ? '覆盖' : '写入'} ${input.path}（${String(bytes)} 字节）。`,
          },
        ],
        output: { path: input.path, kind: existed ? 'overwritten' : 'created', bytes },
      };
    },
  });

const exists = async (fs: import('@xm/kernel').ExecutionFileSystem, path: string): Promise<boolean> => {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
};
