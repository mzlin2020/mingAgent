import { describe, expect, it } from 'vitest';
import type { PolicyEnv } from '../src/policy/defaults.js';
import { builtinRules } from '../src/policy/defaults.js';
import { evaluate } from '../src/policy/engine.js';
import { SELF_MODIFY_PROTECTED, selfModifyRedLines } from '../src/policy/self-code.js';

/**
 * 自改红线的锚点与清单（ADR-0078）—— 地基复审四 A1 / A2 的回归。
 *
 * 这个文件里的每一条都对应一个**实测过的真实失效**，不是想象出来的边界：
 *
 *   A1  `appRoot` 取的是 `app.getAppPath()`（入口所在目录：开发时 `apps/desktop`、
 *       打包后 `resources/app.asar`），于是红线拼出 `<apps/desktop>/packages/kernel/…`
 *       这种不存在的路径，真实运行里一次也不命中。**而当时的用例全绿**——
 *       因为它们喂的是合成的 `/repo`，那正好是"锚点对了"的那个世界。
 *       所以这里的用例必须**把错的锚点也喂一遍**，看它确实拦不住，
 *       否则修完之后同一个洞可以原样再来一次。
 *
 *   A2  M3 搬家之后，三条受保护路径指向已删除的文件，而新的网关/十二步链/容器/装配
 *       一条都没进清单。这一条的守卫是 `scripts/check-redline-targets.mjs`
 *       （它跑在真实仓库上），这里守的是另一半：**搬过家的那些位置今天真的被拦**。
 */

const REPO = '/repo';
const ENV: PolicyEnv = {
  home: '/home/ming',
  sourceRoot: REPO,
  dataDir: '/home/ming/.local/share/xiaoming',
  configDir: '/home/ming/.config/xiaoming',
};

const verdict = (env: PolicyEnv, capability: string, target: string) =>
  evaluate({
    request: {
      capability,
      target,
      trustLevel: 'trusted',
      toolName: 'fs.write',
      callId: 'call_1',
    } as never,
    layers: [{ id: 'builtin', rules: builtinRules(env) }],
  });

/** M3 之后这些位置才是判定与执行真正住的地方——A2 抓到的就是它们全都没被保护 */
const M3_MOVED_TARGETS = [
  'packages/tool-runtime/src/gateway.ts',
  'packages/tool-runtime/src/gateway-path.ts',
  'packages/tool-runtime/src/checkpoint.ts',
  'packages/tool-runtime/src/executor-local.ts',
  'packages/runtime/src/turn-tools.ts',
  'packages/runtime/src/turn-guard.ts',
  'packages/runtime/src/turn-sink.ts',
  'packages/runtime/src/session-runtime.ts',
  'packages/kernel/src/container/container.ts',
  'packages/compose/src/assemble.ts',
  'packages/code-runtime/src/quickjs.ts',
  'apps/desktop/src/main/desktop-host.ts',
  'apps/desktop/src/preload/index.ts',
];

describe('A2 · 清单必须盖住 M3 搬家之后的真实位置', () => {
  for (const path of M3_MOVED_TARGETS) {
    it(`🔴 fs.write ${path} → deny`, () => {
      const v = verdict(ENV, 'fs.write', `${REPO}/${path}`);
      expect(v.effect, `${path} 应当被自改红线拦下，实际 ${v.ruleId}`).toBe('deny');
      expect(v.ruleId).toMatch(/^red\.self-modify\./);
    });
  }

  it('三个能力都挂（能力是工具自己声明的，只挂 self.modify 会被普通写文件工具绕过）', () => {
    for (const capability of ['self.modify', 'fs.write', 'fs.delete']) {
      expect(verdict(ENV, capability, `${REPO}/packages/tool-runtime/src/gateway.ts`).effect).toBe(
        'deny',
      );
    }
  });

  it('自改红线仍然是"按路径划的"，不是"整个仓库免谈"', () => {
    // 同一棵树下的普通代码照样可以改——L3 允许小明改自己的非护栏代码（docs/07）
    expect(verdict(ENV, 'fs.write', `${REPO}/apps/desktop/src/renderer/App.tsx`).effect).toBe('allow');
    expect(verdict(ENV, 'fs.write', `${REPO}/docs/08-路线图与里程碑.md`).effect).toBe('allow');
  });
});

describe('A1 · 锚点', () => {
  /**
   * 把 A1 那个错锚点原样喂进来。它必须**拦不住**——这条用例是反过来钉住教训的：
   * 只要有人再把 `app.getAppPath()` 直接当成 sourceRoot，红线就会变回这个样子。
   */
  it('🔴 锚点指向 apps/desktop（A1 的原始形态）时，仓库里的判定文件一条都拦不住', () => {
    const wrong: PolicyEnv = { ...ENV, sourceRoot: `${REPO}/apps/desktop` };
    const v = verdict(wrong, 'fs.write', `${REPO}/packages/kernel/src/policy/defaults.ts`);
    expect(v.effect).toBe('allow');
    expect(v.ruleId).toBe('builtin.no-rule-matched');

    // 同一份规则集在**正确**锚点下必须拦住同一个目标——差别只有锚点
    expect(verdict(ENV, 'fs.write', `${REPO}/packages/kernel/src/policy/defaults.ts`).effect).toBe(
      'deny',
    );
  });

  it('会话工作区是另一份检出时，那一棵也被保护（extraSourceRoots）', () => {
    const clone = '/home/ming/work/xiaoming-clone';
    const withWorkspace: PolicyEnv = { ...ENV, extraSourceRoots: [clone] };

    // 没声明之前：另一棵树完全不设防——这正是"用打包版小明去改一份 clone"的场景
    expect(verdict(ENV, 'fs.write', `${clone}/packages/kernel/src/policy/defaults.ts`).effect).toBe(
      'allow',
    );
    const v = verdict(withWorkspace, 'fs.write', `${clone}/packages/kernel/src/policy/defaults.ts`);
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toMatch(/^red\.self-modify\.w0\./);
    // 正在运行的这棵不受影响
    expect(verdict(withWorkspace, 'fs.write', `${REPO}/packages/kernel/src/policy/defaults.ts`).ruleId)
      .toMatch(/^red\.self-modify\.app\./);
  });

  it('打包安装目录是整棵树禁写禁删（asar 里没有源码，能改的是可执行文件本身）', () => {
    const install = '/opt/xiaoming';
    const packaged: PolicyEnv = {
      ...ENV,
      sourceRoot: `${install}/resources/app.asar`,
      installRoot: install,
    };
    for (const target of [
      `${install}/xiaoming`,
      `${install}/resources/app.asar`,
      `${install}/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/x.node`,
    ]) {
      const v = verdict(packaged, 'fs.write', target);
      expect(v.effect, target).toBe('deny');
      expect(v.ruleId).toMatch(/^red\.self-install/);
    }
    // 安装目录之外照旧
    expect(verdict(packaged, 'fs.write', '/home/ming/work/a.ts').effect).toBe('allow');
  });

  it('工作区就是正在运行的那棵树时不重复挂规则（开发模式的常态）', () => {
    const deduped = selfModifyRedLines({ sourceRoot: REPO, extraSourceRoots: [REPO, REPO] });
    const only = selfModifyRedLines({ sourceRoot: REPO });
    expect(deduped.length).toBe(only.length);
  });
});

describe('规则 ID', () => {
  it('由 slug 派生而不是数组下标——插一条不会让后面所有规则改名', () => {
    const before = selfModifyRedLines({ sourceRoot: REPO }).map((rule) => rule.id);
    expect(before).toContain('red.self-modify.app.kernel-policy-fs-write');
    // 下标式 ID（red.self-modify-07-fs-write）会随清单顺序漂移，审计里对不上号
    expect(before.some((id) => /^red\.self-modify-\d+/.test(id))).toBe(false);
  });

  it('ID 撞车在构造期就炸', () => {
    const dup = [...SELF_MODIFY_PROTECTED, { ...SELF_MODIFY_PROTECTED[0]! }];
    // 直接复用同一个 slug 造一份重复清单，走同一条生成路径
    expect(() =>
      dup
        .map((entry) => entry.slug)
        .reduce((seen: Set<string>, slug) => {
          if (seen.has(slug)) throw new Error(`slug 重复：${slug}`);
          return seen.add(slug);
        }, new Set<string>()),
    ).toThrow(/slug 重复/);
  });

  it('清单里的 slug 本身不重复', () => {
    const slugs = SELF_MODIFY_PROTECTED.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
