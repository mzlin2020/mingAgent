import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 铁律 1：契约包依赖只有 zod。
 *
 * dependency-cruiser 从**依赖图**上守这条；这个测试从 **package.json** 上守。
 * 两处都要，因为它们漏的东西不一样：depcruise 看不见"声明了但还没 import"的依赖，
 * 而声明本身就会被 pnpm 安装进渲染层的产物里。
 */
describe('契约包零依赖', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it('dependencies 恰好只有 zod', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
  });

  it('没有 devDependencies / peerDependencies —— 一切工具都在根上', () => {
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  /**
   * zod 锁的是**精确版本**（不是 ^）。
   * 原因：assertToolSchema 要遍历 Zod 的 `_zod.def` 内部结构，那是半公开 API，
   * 不受 semver 保护。精确锁定 + tool-schema.test.ts 一起构成升级 zod 时的闸门。
   */
  it('zod 版本被精确锁定', () => {
    expect(pkg.dependencies?.zod).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
