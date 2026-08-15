import type { InvariantInstaller } from '@xm/kernel';

/**
 * 无运行时不变量：本包拥有的两条关系，一条观察不到、一条还没进事件流。
 *
 * 这一条的理由值得写长一点，因为它指向一件该做而暂时做不了的事。本包拥有两样东西：
 *
 * · **网关**：它的不变量是"判定看到的路径就是工具打开的那个路径"，而这条关系的两端
 *   一端在事件里（`permission.request.target`）、另一端在工具的进程调用里——
 *   后者不在事件流上，观察不到。它由 `tests/` 里的 8.3 短名与符号链接用例守着。
 *
 * · **checkpoint**：本该断言"每一次成功的写入之前都有一个还原点"（ADR-0003 承诺的
 *   无条件还原点，而"`checkpoint.created` 无人发出"正是八次事故之一）。今天断不了：
 *   `checkpointer.before()` 可以合法地返回 `undefined`（目标不支持快照），而**"这次本该
 *   有还原点"这个事实没有落进事件流**——只落了成功的那些。要断言它，得先让
 *   checkpointer 把"判断结果"记下来，那是一次契约变更，不在 M3-g 范围内。
 *
 * 重新审视的条件：上面那条契约变更一旦发生，这条不变量必须补上。
 */
export const toolRuntimeInvariants: InvariantInstaller = () => undefined;
