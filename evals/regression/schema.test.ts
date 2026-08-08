import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `evals/regression/*.json` 的最小格式校验（ADR-0032 #4）。
 *
 * 这是"护栏本身要有护栏"的又一个小例子：这份骨架此刻没有评测运行器去读它，
 * 意味着**没有任何东西会在格式写错的第一时间报错**——一份字段名手滑打错的
 * JSON 会一直静静地待在这里，直到 M5 真的写运行器那天才被发现，那时候多半
 * 已经攒了一堆同样的错误。这条测试现在就把 `evals/README.md` 里写的 schema
 * 变成一个可执行的约束，不等运行器落地。
 */
const DIR = new URL('.', import.meta.url).pathname;

function regressionFiles(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith('.json'));
}

describe('evals/regression/ 案例文件的最小 schema', () => {
  const files = regressionFiles();

  it('目录里至少有一条真实案例——骨架不能只是空目录', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of regressionFiles()) {
    it(`${file}：符合 README.md 里定义的最小 schema`, () => {
      const raw = readFileSync(join(DIR, file), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      expect(typeof parsed).toBe('object');
      const c = parsed as Record<string, unknown>;

      expect(typeof c.id).toBe('string');
      expect(c.id).toBe(file.replace(/\.json$/, ''));
      expect(c.kind).toBe('regression');
      expect(typeof c.title).toBe('string');

      const source = c.source as Record<string, unknown> | undefined;
      expect(typeof source).toBe('object');
      expect(typeof source?.issue).toBe('string');
      expect(typeof source?.fixedBy).toBe('string');
      expect(typeof source?.discoveredAt).toBe('string');
      expect(typeof source?.fixedAt).toBe('string');

      expect(typeof c.scenario).toBe('string');

      const assertion = c.assertion as Record<string, unknown> | undefined;
      expect(typeof assertion).toBe('object');
      expect(typeof assertion?.description).toBe('string');

      // regressionTest 指向真正锁住这个行为的测试——这一字段不能是空字符串，
      // 否则这条案例除了一份文档之外什么也没锁住
      expect(typeof c.regressionTest).toBe('string');
      expect((c.regressionTest as string).length).toBeGreaterThan(0);
    });
  }
});
