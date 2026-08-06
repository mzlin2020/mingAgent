import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

export const FS_LIST = 'fs.list';

/**
 * 列出一个目录。
 *
 * ── 不偷偷跳过任何东西 ──
 *
 * 几乎所有同类工具都会默默忽略 `.git` / `node_modules` / 点开头的文件。那很方便，
 * 也和"悄悄截断"是同一类错误：模型基于一份它以为完整的清单下结论，
 * 而少掉的恰恰可能是关键的那个（`.env.example`、`.github/workflows`）。
 *
 * 这里的做法是**列出来但不展开**：大目录显示条目数并说明没有递归进去，
 * 于是"这里还有东西"这件事是模型看得见的，要不要看由它决定。
 */
const Input = z.strictObject({
  path: z.string().min(1).describe('要列出的目录路径'),
  depth: z.number().int().min(1).max(4).optional().describe('递归层数，默认 1（只列直接子项）'),
});

/** 一次列出的条目上限。超过就停并说明——不是"截断到看不见"，是"说清楚还有多少" */
const MAX_ENTRIES = 500;
/** 不递归进去的目录名。**只影响递归，不影响是否列出** */
const NO_DESCEND = new Set(['.git', 'node_modules', '.pnpm-store', 'dist', 'target', '.venv']);

export const fsListTool = (): RegisteredTool =>
  defineTool({
    name: FS_LIST,
    group: 'fs',
    description:
      '列出目录内容，标注类型与大小。默认只列直接子项，depth 可递归。' +
      '.git / node_modules 这类目录会被列出但不展开。',
    inputSchema: Input,
    risk: 'safe',
    capabilities: ['fs.read'],
    concurrency: 'parallel',
    pathInputs: ['path'],
    resources: (input) => [{ kind: 'path', mode: 'read', glob: input.path }],

    async *execute(input, ctx): AsyncIterable<ToolProgress> {
      const root = input.path;
      const info = await stat(root);
      if (!info.isDirectory()) {
        yield {
          kind: 'result',
          forModel: [{ type: 'text', text: `${root} 不是目录。用 fs.read 读它。` }],
        };
        return;
      }

      const lines: string[] = [];

      /** 返回值是"有没有撞到条目上限"。用返回值而不是外层的可变标志，是为了让递归里的
       *  提前退出能一路传上来——半路停下却报"列全了"，就是又一次悄悄的省略 */
      const walk = async (dir: string, depth: number): Promise<boolean> => {
        if (ctx.signal.aborted) return false;
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const e of entries) {
          if (lines.length >= MAX_ENTRIES) return true;
          const full = join(dir, e.name);
          const shown = relative(root, full) || e.name;

          if (e.isDirectory()) {
            const skip = NO_DESCEND.has(e.name);
            lines.push(`${shown}/${skip ? '    （未展开）' : ''}`);
            if (!skip && depth > 1 && (await walk(full, depth - 1))) return true;
          } else if (e.isSymbolicLink()) {
            // 符号链接**标出来**：它的判权目标由网关 realpath 决定，可能落在目录之外
            lines.push(`${shown}    → 符号链接`);
          } else if (e.isFile()) {
            const size = await sizeOf(full);
            lines.push(`${shown}    ${size}`);
          } else {
            lines.push(`${shown}    （设备/管道/套接字）`);
          }
        }
        return false;
      };

      const truncated = await walk(root, input.depth ?? 1);

      const header = `${root}（${String(lines.length)} 项${truncated ? `，已达 ${String(MAX_ENTRIES)} 项上限，还有更多未列出` : ''}）`;
      yield {
        kind: 'result',
        forModel: [
          { type: 'text', text: lines.length === 0 ? `${root} 是空目录。` : `${header}\n${lines.join('\n')}` },
        ],
      };
    },
  });

async function sizeOf(file: string): Promise<string> {
  try {
    const s = await stat(file);
    return s.size < 1024
      ? `${String(s.size)} B`
      : s.size < 1024 * 1024
        ? `${(s.size / 1024).toFixed(1)} KB`
        : `${(s.size / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    // 列举与 stat 之间文件可能已经没了。**说出来**，不要显示一个编的大小
    return '（读不到大小）';
  }
}
