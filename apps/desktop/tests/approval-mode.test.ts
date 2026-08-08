import { describe, expect, it } from 'vitest';
import { ApprovalModeStore, TIER_OF } from '../src/main/approval-mode.js';

/**
 * 三档审批模式（docs/09 C6，ADR-0030）的纯逻辑单测。
 *
 * 拆出 `approval-mode.ts` 就是为了让它能脱离 `services.ts`/Electron 单独测——
 * `services.ts` 直接 `import 'electron'`，vitest 跑不起来（跟 `multimodal-input.ts`
 * 抽出去的理由一样）。这里测的是两件事：模式到 `tier` 的映射，以及会话级默认值/
 * 立即生效这两条行为约定。
 */
describe('TIER_OF：ApprovalMode → PermissionTier 的映射', () => {
  it('请求批准映射到 balanced —— 与今天的默认行为一致', () => {
    expect(TIER_OF.ask).toBe('balanced');
  });

  it('帮我批准与完全访问权限都映射到 yolo —— 同一套已验证过的判定机制', () => {
    expect(TIER_OF.auto).toBe('yolo');
    expect(TIER_OF.full).toBe('yolo');
  });
});

describe('ApprovalModeStore：会话级、不持久化', () => {
  it('没记录过的会话默认是 ask，不是 undefined', () => {
    const store = new ApprovalModeStore();
    expect(store.get('unknown-session')).toBe('ask');
  });

  it('init() 把会话重置回 ask —— 新会话一律从这里起步', () => {
    const store = new ApprovalModeStore();
    store.set('s1', 'full');
    store.init('s1');
    expect(store.get('s1')).toBe('ask');
  });

  it('set() 立即生效，不需要重启/重连', () => {
    const store = new ApprovalModeStore();
    store.set('s1', 'auto');
    expect(store.get('s1')).toBe('auto');
    expect(TIER_OF[store.get('s1')]).toBe('yolo');
  });

  it('会话之间互不影响', () => {
    const store = new ApprovalModeStore();
    store.set('s1', 'full');
    store.set('s2', 'ask');
    expect(store.get('s1')).toBe('full');
    expect(store.get('s2')).toBe('ask');
  });
});
