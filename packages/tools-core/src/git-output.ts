import { z } from 'zod';

/**
 * 四个 git 工具**共用**的规范输出值（ADR-0071）。
 *
 * ── 为什么这一份是四个工具共用的，而别的工具各写各的 ──
 *
 * 因为它们本来就共用一个信封：`envelope()` / `failure()` / `commonFailure()` 三个函数
 * 拼出来的那个对象，四个工具原样 `JSON.stringify` 给模型。这次迁移在这里没有发明新形状，
 * 只是把一个**过去是 `Record<string, unknown>` 的运行期约定**写成了 schema。
 *
 * 收益也正在这里：写下来之后，`kind` 那一列的十个取值第一次是闭集，
 * 加一种失败分类不再是"随手多传一个字符串"。
 *
 * `stdout` / `stderr` 留在规范值里是刻意的——git 的很多信息只存在于它的输出文本里
 * （冲突文件清单、hook 打印的东西），程序绕不开它。但**结构化得出来的就不要让程序去 grep**：
 * `status` 的 `entries`、`commit` 的 `scope` 就是为此存在的。
 */
export const GitOutput = z.strictObject({
  ok: z.boolean(),
  /**
   * 前四个是各工具成功时的种类，后六个是失败分类。
   *
   * `hook_failed` 是 `command_failed` 的细化：commit 被某个钩子挡了，`hook` 字段给出钩子名。
   */
  kind: z.enum([
    'status',
    'diff',
    'branch',
    'commit',
    'interrupted',
    'not_repository',
    'command_failed',
    'conflict',
    'empty_commit',
    'hook_failed',
  ]),
  argv: z.array(z.string()),
  cwd: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  timedOut: z.boolean().optional(),
  spawnError: z.string().optional(),
  /** 入参自己就不合法时的说明（根本没起进程），此时 stdout/stderr 都是空串 */
  message: z.string().optional(),
  /** `git.status` 专有：`## ` 之后那一行 */
  branch: z.string().optional(),
  /** `git.status` 专有：porcelain 的每一行拆成状态码与路径 */
  entries: z.array(z.strictObject({ status: z.string(), path: z.string() })).optional(),
  /** `git.commit` 专有：本次提交实际覆盖的 `--name-status` 行 */
  scope: z.array(z.string()).optional(),
  /** `kind: 'hook_failed'` 时挡下这次提交的钩子名 */
  hook: z.string().optional(),
});

export type GitOutput = z.infer<typeof GitOutput>;
