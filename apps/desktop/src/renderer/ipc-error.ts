import type { SessionId } from '@xm/contracts';

/**
 * IPC 调用失败时抛出的错误。**定义在这里而不是 `bridge.ts`**：`bridge.ts` 顶层
 * 引用了 `window`（`XmBridge`/`bridge()`），只能在有 DOM lib 的编译配置下过关
 * （`apps/desktop/tsconfig.renderer.json`）；`tsconfig.tests.json`（vitest 用的
 * 那份）没有 DOM lib，专给 Node 环境用。`classifyIpcError` 需要能在纯 Node 的
 * 测试里单独跑（见下），如果它去 `import { IpcError } from './bridge.js'`，
 * 类型检查会把整个 `bridge.ts`（连带它对 `window` 的引用）一起拖进
 * `tsconfig.tests.json` 的检查范围而报错——这不是"用不到就不检查"，TS 按
 * import 图检查，不看 `include`。`bridge.ts` 反过来从这里导入 `IpcError`。
 */
export class IpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

/**
 * 把一次 IPC 调用失败分类到该写进渲染层状态的哪个字段（M1-e 错误态呈现）。
 *
 * ── 为什么单独抽成一个不依赖 zustand 的纯函数 ──
 *
 * 分类逻辑本身是"给一个 `unknown`，判断该往哪个字段写"，与 `set()` 无关；
 * 抽出来才能在不拉起整个 store 的情况下单独测试，见 `tests/ipc-error.test.ts`。
 *
 * ── 为什么只分类 `WriteLeaseError` ──
 *
 * `main/ipc.ts` 的 `handle()` catch 块把 `e.name` 当 `code` 回传，`WriteLeaseError`
 * （会话被另一个写句柄占用——通常是另一个窗口/另一个小明进程正开着同一个会话）
 * 因此天然带着 `code:'WriteLeaseError'` 过桥。这是目前唯一一个"落进通用错误横幅
 * 会让用户不知道下一步该做什么"的错误码：一句没有区分度的原始报错，和"关掉另一个
 * 窗口再试一次"之间差着一次翻译。其余错误码（`policy_denied`/`user_rejected`/
 * `permission_denied` 等）已经各自有专门的呈现路径（审批卡片、`TurnErrorBanner`
 * 读的 `error.raised` 事件），不需要在这里重复分类。
 *
 * `sessionConflict` 需要 `sessionId` 才能定位是"哪个会话"冲突了——调用方在
 * 会话作用域之外（比如 `refreshSessions`）没有单一 `sessionId` 可传，这时永远
 * 落进通用 `error` 字段，这正是**未分类错误的最后防线**：新出现的错误码在被
 * 专门分类之前，至少还能被用户看到，而不是静默吞掉。
 */
export type ClassifiedIpcError =
  | { readonly field: 'sessionConflict'; readonly value: { readonly sessionId: SessionId; readonly message: string } }
  | { readonly field: 'error'; readonly value: string };

export function classifyIpcError(e: unknown, sessionId?: SessionId): ClassifiedIpcError {
  if (sessionId !== undefined && e instanceof IpcError && e.code === 'WriteLeaseError') {
    return { field: 'sessionConflict', value: { sessionId, message: e.message } };
  }
  return { field: 'error', value: e instanceof Error ? e.message : String(e) };
}
