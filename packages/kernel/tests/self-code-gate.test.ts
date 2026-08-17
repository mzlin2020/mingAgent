import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 闸门脚本是 .mjs，没有类型声明；这里就是要跑它真正的那份实现
import { findStaleTargets } from '../../../scripts/check-redline-targets.mjs';
import { SELF_MODIFY_PROTECTED } from '../src/policy/self-code.js';

/**
 * 指向闸门的**反向演练**（ADR-0078）。
 *
 * 本仓库的纪律是"加一条护栏之后，必须先构造一个它真正要拦的场景、看它红一次"。
 * 那次实机演练已经做过了（把 `packages/tool-runtime/src` 改个名，闸门当场红、退出码 1，
 * 记在 ADR-0078 里）。这里把同一件事固化成用例，免得下次有人"顺手优化"匹配逻辑之后，
 * 闸门变成永远绿的那种。
 *
 * 用的是脚本里那份**真实的** `findStaleTargets`，不是复制一份逻辑——
 * 复制一份就等于测了一个不会被跑到的东西。
 */

const stale = findStaleTargets as (
  protectedPaths: readonly { slug: string; glob: string; why: string }[],
  paths: readonly string[],
) => readonly { slug: string; glob: string }[];

describe('check-redline-targets 的反向演练', () => {
  it('🔴 受保护的目录被改名 → 闸门必须报出那一条', () => {
    const entry = { slug: 'tool-runtime', glob: 'packages/tool-runtime/src/**', why: '能力网关' };
    const afterRename = ['packages/tool-runtime', 'packages/tool-runtime/src2/gateway.ts'];
    expect(stale([entry], afterRename)).toEqual([{ slug: entry.slug, glob: entry.glob }]);
  });

  it('🔴 单文件被搬走 → 同样报出来', () => {
    const entry = { slug: 'compose', glob: 'packages/compose/src/assemble.ts', why: '装配' };
    expect(stale([entry], ['packages/compose/src/assemble2.ts'])).toHaveLength(1);
    expect(stale([entry], ['packages/compose/src/assemble.ts'])).toHaveLength(0);
  });

  it('目录自身也算命中——`a/**` 要盖住 `a` 本身（globMatch 的既有语义）', () => {
    const entry = { slug: 'scripts', glob: 'scripts/**', why: '护栏' };
    expect(stale([entry], ['scripts'])).toHaveLength(0);
  });

  it('段内通配也要能命中：`turn*.ts` 命中 turn-tools.ts', () => {
    const entry = { slug: 'runtime-turn', glob: 'packages/runtime/src/turn*.ts', why: '十二步链' };
    expect(stale([entry], ['packages/runtime/src/turn-tools.ts'])).toHaveLength(0);
    expect(stale([entry], ['packages/runtime/src/other.ts'])).toHaveLength(1);
  });

  it('闸门用的是判定引擎那一个 globMatch —— 清单里每条都能被它匹配上', () => {
    // 这一条防的是"闸门自己写了个更宽松的匹配器"：那会让闸门绿着、红线空着
    const impossible = SELF_MODIFY_PROTECTED.map((entry) => ({ ...entry }));
    expect(stale(impossible, []).length).toBe(SELF_MODIFY_PROTECTED.length);
  });
});
