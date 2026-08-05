import { z } from 'zod';
import type { ToolProgress } from '@xm/contracts';
import type { RegisteredTool } from '@xm/kernel';
import { defineTool } from '@xm/kernel';

/**
 * M0-b 的玩具工具。**刻意零 I/O。**
 *
 * 冒烟要证明的是"权限闸门长在工具调用的路径上"，不是"文件能不能删"。让冒烟真去动
 * 文件系统，就得处理临时目录、清理与平台差异，而这些跟要验的东西无关，还会让一次
 * 失败的冒烟留下垃圾。真实工具集是 M1。
 *
 * 两个工具覆盖判定的三条路径：
 *   · `demo.echo`        零能力声明 → 不产生任何权限事件
 *   · `demo.fake-delete` 声明 `fs.delete`：目标是家目录 → **红线拒绝**（不执行）；
 *                        目标是普通路径 → `def.fs-delete` 的 **ask** → 由应答者定夺
 *
 * `demo.fake-delete` 只是打印"假装删了"，不真删——名字里的 `fake` 是刻意的，
 * 一个声明了 `fs.delete` 却真会删东西的玩具工具，早晚会有人在别的测试里顺手复用它。
 */

export const DEMO_ECHO = 'demo.echo';
export const DEMO_FAKE_DELETE = 'demo.fake-delete';

export const echoTool = (): RegisteredTool =>
  defineTool({
    name: DEMO_ECHO,
    group: 'demo',
    description: '把入参原样回显。仅用于冒烟。',
    inputSchema: z.strictObject({ text: z.string() }),
    risk: 'safe',
    capabilities: [],
    concurrency: 'parallel',
    // eslint-disable-next-line @typescript-eslint/require-await
    async *execute(input): AsyncIterable<ToolProgress> {
      yield { kind: 'progress', message: '回显中' };
      yield { kind: 'result', forModel: [{ type: 'text', text: input.text }] };
    },
  });

export const fakeDeleteTool = (): RegisteredTool =>
  defineTool({
    name: DEMO_FAKE_DELETE,
    group: 'demo',
    description: '假装删除一个目录（不真删）。仅用于冒烟：它存在的意义是被闸门判定。',
    inputSchema: z.strictObject({ path: z.string() }),
    risk: 'high',
    capabilities: ['fs.delete'],
    concurrency: 'exclusive',
    // eslint-disable-next-line @typescript-eslint/require-await
    async *execute(input): AsyncIterable<ToolProgress> {
      yield { kind: 'result', forModel: [{ type: 'text', text: `假装删除了 ${input.path}` }] };
    },
  });

const PathInput = z.object({ path: z.string() });

/**
 * 从工具入参提取权限判定的 `target`。
 *
 * 交给装配方而不是内核，是因为不同能力的 target 语义根本不同：路径类能力要绝对路径，
 * 而 `shell.exec` 的"目标"是一整条命令行——docs/09 C4 记的就是这件事，M1 前必须定。
 * 这里只处理路径类工具，`shell.exec` 在 M0-b 不存在。
 */
export const demoTargetOf = (toolName: string, input: unknown): string => {
  if (toolName !== DEMO_FAKE_DELETE) return '';
  const parsed = PathInput.safeParse(input);
  return parsed.success ? parsed.data.path : '';
};
