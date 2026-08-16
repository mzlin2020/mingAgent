import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolRowTitle } from '../src/renderer/lib/tool-row.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer');

describe('toolRowTitle', () => {
  it('只按卡片种类取标题，四种各走各的字段', () => {
    expect(toolRowTitle({ kind: 'generic', title: '读文件', summary: '读文件 /tmp/a' })).toBe(
      '读文件',
    );
    expect(
      toolRowTitle({ kind: 'terminal', command: 'ls -la', summary: 'ls -la' }),
    ).toBe('ls -la');
    expect(
      toolRowTitle({
        kind: 'diff',
        summary: '改了 2 个文件',
        files: [{ kind: 'full', path: 'a.ts', oldText: null, newText: 'x' }],
      }),
    ).toBe('编辑');
    expect(toolRowTitle({ kind: 'search', summary: '找到 3 处', query: 'TODO', truncated: false })).toBe(
      'TODO',
    );
    expect(toolRowTitle({ kind: 'search', summary: '找到 3 处', truncated: false })).toBe('搜索');
  });
});

describe('M3-f 渲染层仍不认识具体工具', () => {
  it('工具行与卡片渲染器源码里不出现内建工具名', () => {
    const files = [
      'lib/tool-row.ts',
      'components/tool-row.tsx',
      'components/dispatch-row.tsx',
      'components/details-view.tsx',
      'components/cards.tsx',
      'lib/card-registry.ts',
    ];
    const banned = /\b(?:fs\.(?:read|write|list|delete)|shell\.exec|search\.text|edit\.apply|run_code)\b/;
    for (const file of files) {
      const text = readFileSync(join(SRC, file), 'utf8');
      expect(text, file).not.toMatch(banned);
    }
  });
});
