import type { PermissionTier } from '@xm/contracts';
import type { ApprovalMode } from '../shared/ipc.js';

/**
 * `ApprovalMode` → `PermissionTier` 的映射（docs/09 C6，ADR-0030）。
 *
 * `auto`/`full` 刻意映射到同一个 `yolo`——两者是同一套已经过 ADR-0017/C5 验证过的
 * 判定机制（跳过 `ask`，红线与任何 `deny` 原样生效），区别只在桌面 UI 的开启门槛
 * 与文案，不是新开一档凌驾于红线之上的规则集。
 */
export const TIER_OF: Record<ApprovalMode, PermissionTier> = {
  ask: 'balanced',
  auto: 'yolo',
  full: 'yolo',
};

/**
 * 每会话的审批模式。**纯内存、不持久化**（docs/06 对 YOLO 开关的既有约束）：
 * 不读也不写 `config.json`，重启应用后所有会话回到默认的 `'ask'`。
 *
 * 抽成单独的类、脱离 `services.ts`，是为了能在没有 Electron 的环境里单测——
 * `services.ts` 直接 `import 'electron'`，vitest 跑不起来（跟 `multimodal-input.ts`
 * 抽出去的理由一样）。
 */
export class ApprovalModeStore {
  readonly #modes = new Map<string, ApprovalMode>();

  /** 没记录过（或已被 `close()`）的会话一律当作默认档 `'ask'`，不是"未定义" */
  get(sessionId: string): ApprovalMode {
    return this.#modes.get(sessionId) ?? 'ask';
  }

  set(sessionId: string, mode: ApprovalMode): void {
    this.#modes.set(sessionId, mode);
  }

  /** 新会话一律从 `'ask'` 起步——`createSession()` 里调用 */
  init(sessionId: string): void {
    this.#modes.set(sessionId, 'ask');
  }
}
