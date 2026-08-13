import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '@xm/tools-core';

const lines = (from: number, to: number): string =>
  `${Array.from({ length: to - from + 1 }, (_unused, i) => `line ${String(from + i)}`).join('\n')}\n`;

describe('unifiedDiff', () => {
  it('内容相同时返回空串', () => {
    expect(unifiedDiff('a.ts', 'x\ny\n', 'x\ny\n')).toBe('');
    expect(unifiedDiff('a.ts', '', '')).toBe('');
  });

  it('单行替换只输出该行及其上下文，与文件大小无关', () => {
    const before = lines(1, 400);
    const after = before.replace('line 200\n', 'line 200 已改\n');
    const diff = unifiedDiff('big.ts', before, after);

    expect(diff.split('\n')).toEqual([
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -197,7 +197,7 @@',
      ' line 197',
      ' line 198',
      ' line 199',
      '-line 200',
      '+line 200 已改',
      ' line 201',
      ' line 202',
      ' line 203',
    ]);
  });

  it('相距很远的两处改动输出两个 hunk，相邻的两处合并成一个', () => {
    const before = lines(1, 100);
    const far = before.replace('line 5\n', 'line 5 改\n').replace('line 80\n', 'line 80 改\n');
    expect(unifiedDiff('a.ts', before, far).match(/^@@ /gmu)).toHaveLength(2);

    // 间隔 5 行（<= 2*context+1）应当并成一个 hunk，否则两个 hunk 的上下文会重叠
    const near = before.replace('line 40\n', 'line 40 改\n').replace('line 45\n', 'line 45 改\n');
    expect(unifiedDiff('a.ts', before, near).match(/^@@ /gmu)).toHaveLength(1);
  });

  it('纯插入与纯删除的计数与起始行号符合 unified diff 惯例', () => {
    const insert = unifiedDiff('a.ts', 'a\nb\n', 'a\n新\nb\n');
    expect(insert).toContain('@@ -1,2 +1,3 @@');
    expect(insert).toContain('+新');

    const remove = unifiedDiff('a.ts', 'a\nb\nc\n', 'a\nc\n');
    expect(remove).toContain('@@ -1,3 +1,2 @@');
    expect(remove).toContain('-b');

    // 从空文件插入：旧侧计数为 0，起始行号退回 0
    expect(unifiedDiff('a.ts', '', 'x\n')).toContain('@@ -0,0 +1,1 @@');
  });

  it('末尾缺换行会如实标注，且与"多一个空行"区分开', () => {
    const diff = unifiedDiff('a.ts', 'a\nb', 'a\nB');
    expect(diff).toContain('-b');
    expect(diff).toContain('+B');
    expect(diff.match(/\\ No newline at end of file/gu)).toHaveLength(2);

    // "a" 与 "a\n" 是两份不同的文件，diff 不能说它们相同
    const trailing = unifiedDiff('a.ts', 'a', 'a\n');
    expect(trailing).not.toBe('');
    expect(trailing).toContain('\\ No newline at end of file');
  });

  it('CRLF 的 \\r 留在行尾，不被悄悄规范化', () => {
    const diff = unifiedDiff('a.ts', 'x\r\ny\r\n', 'x\r\nY\r\n');
    expect(diff).toContain('-y\r');
    expect(diff).toContain('+Y\r');
    expect(diff).toContain(' x\r');
  });

  it('路径统一用正斜杠，三平台产出同一份文本', () => {
    expect(unifiedDiff('src\\a.ts', 'a\n', 'b\n')).toContain('--- a/src/a.ts');
    expect(unifiedDiff('src\\a.ts', 'a\n', 'b\n')).toContain('+++ b/src/a.ts');
  });

  it('编辑距离超限时退化为整段替换，仍是合法 diff 而不是崩溃或吃满内存', () => {
    // 逐行全不相同、且长度远超 MAX_EDIT_DISTANCE：走 wholeReplacement 退路
    const before = Array.from({ length: 4000 }, (_u, i) => `old ${String(i)}`).join('\n');
    const after = Array.from({ length: 4000 }, (_u, i) => `new ${String(i)}`).join('\n');
    const diff = unifiedDiff('a.ts', before, after);

    expect(diff.match(/^@@ /gmu)).toHaveLength(1);
    expect(diff).toContain('-old 0');
    expect(diff).toContain('+new 0');
    expect(diff.split('\n').length).toBeLessThan(4000 * 2 + 10);
  });

  it('同一对输入重复调用逐字节一致（事件与哈希都依赖这点）', () => {
    const before = lines(1, 50);
    const after = before.replace('line 20\n', 'line 20 改\n');
    expect(unifiedDiff('a.ts', before, after)).toBe(unifiedDiff('a.ts', before, after));
  });
});
