import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newRequestId, newSessionId } from '@xm/contracts';
import { builtinRules, evaluate, policyEnvFromPaths } from '@xm/kernel';
import { nodePlatform } from '@xm/platform';
import { openStores } from '@xm/storage';

const ROOT = mkdtempSync(join(tmpdir(), 'xm-open-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * 这个文件盯的是**接线**，不是任何单个模块的功能。
 *
 * 失效模式很具体：红线护着 `<data>/audit.db`，而存储适配器打开的是别的路径——
 * 那时 lint 绿、类型检查绿、depcruise 绿、单测全绿，只有防护没了。
 * M0-a 复审里这类"两边各算一次"的失效出现过三次（ADR-0012 ①），
 * 所以它必须有一条端到端的用例，而不是靠"我们都走 xmDataLayout"这句约定。
 */
describe('平台路径 → 存储落盘位置 → 红线，是同一份定义', () => {
  it('🔴 真正落盘的审计库路径就是红线保护的那个', async () => {
    const dataDir = join(ROOT, 'data');
    const platform = nodePlatform({ appRoot: '/code_mine/mingAgent', dataDir });
    const stores = await openStores(platform.paths());

    try {
      // 事件库确实建在 layout 说的地方
      expect(existsSync(stores.layout.eventsDb)).toBe(true);
      expect(existsSync(stores.layout.blobsDir)).toBe(true);

      const verdict = evaluate({
        request: {
          requestId: newRequestId(),
          sessionId: newSessionId(),
          capability: 'fs.write',
          target: stores.layout.auditDb,
          risk: 'high',
          reason: '接线检查',
          trustLevel: 'model',
        },
        rules: builtinRules(policyEnvFromPaths(platform.paths())),
        tier: 'yolo',
        pathCaseInsensitive: platform.os === 'windows',
      });

      expect(verdict.effect).toBe('deny');
      expect(verdict.ruleId).toBe('red.audit-log-write');
    } finally {
      await stores.close();
    }
  });

  it('数据目录不存在时自动建，不要求调用方先 mkdir', async () => {
    const dataDir = join(ROOT, 'deep', 'nested', 'data');
    const stores = await openStores(
      nodePlatform({ appRoot: '/code_mine/mingAgent', dataDir }).paths(),
    );
    expect(existsSync(dataDir)).toBe(true);
    await stores.close();
  });
});
