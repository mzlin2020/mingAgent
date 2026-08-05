import { describe, expect, it } from 'vitest';
import type { Capability, PermissionRequest, PermissionTier } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { PolicyEnv, XmPaths } from '@xm/kernel';
import { builtinRules, evaluate, policyEnvFromPaths, xmDataLayout } from '@xm/kernel';

/**
 * 审计日志红线（ADR-0014）。
 *
 * 这条防护在 docs/06 §7 里写了整整一个里程碑——"小明自身的策略规则禁止写入该路径"——
 * 而代码里**一条对应规则都没有**：`PolicyEnv` 拿不到数据目录，写不出来。
 * 它和 ADR-0012 ⑧ 记下的那三个"文档里存在、代码里不存在"的扩展点是同一种东西。
 *
 * 所以这个文件按"攻击者会怎么拼这个字符串"写，而不是按"规则里写了什么"写。
 */

const DATA = '/home/ming/.local/share/xiaoming';
const ENV: PolicyEnv = { home: '/home/ming', appRoot: '/repo', dataDir: DATA };
const RULES = builtinRules(ENV);

const req = (capability: Capability, target: string): PermissionRequest => ({
  requestId: newRequestId(),
  sessionId: newSessionId(),
  capability,
  target,
  risk: 'high',
  reason: '测试',
  trustLevel: 'model',
});

const verdict = (capability: Capability, target: string, tier: PermissionTier = 'balanced') =>
  evaluate({ request: req(capability, target), rules: RULES, tier });

describe('审计日志红线', () => {
  it('🔴 写入与删除审计库都被红线拒绝', () => {
    for (const capability of ['fs.write', 'fs.delete'] as const) {
      const v = verdict(capability, `${DATA}/audit.db`);
      expect(v.effect, capability).toBe('deny');
      expect(v.ruleId, capability).toMatch(/^red\.audit-log-/);
    }
  });

  /**
   * WAL 边车文件。这一条是整组里最容易漏、漏了最像"已经防住了"的：
   * 未 checkpoint 的审计记录全在 `audit.db-wal` 里，只护主文件的话，
   * 删掉 wal 就能抹掉最近一段审计，而主文件的大小、mtime 全都纹丝不动。
   */
  it('🔴 -wal / -shm 边车文件同样在红线内', () => {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const v = verdict('fs.delete', `${DATA}/audit.db${suffix}`);
      expect(v.effect, suffix).toBe('deny');
    }
  });

  it('🔴 换一种写法也绕不过去（规范化在匹配之前）', () => {
    for (const target of [
      `${DATA}/./audit.db`,
      `${DATA}//audit.db`,
      `${DATA}/blobs/../audit.db`,
      `${DATA}/audit.db/`,
      '/home/ming/.local/share/xiaoming/../xiaoming/audit.db',
    ]) {
      expect(verdict('fs.delete', target).effect, target).toBe('deny');
    }
  });

  it('🔴 相对路径不被判为"没命中"，而是判为不可判定并拒绝', () => {
    const v = verdict('fs.delete', '.local/share/xiaoming/audit.db');
    expect(v.effect).toBe('deny');
    expect(v.ruleId).toBe('builtin.invalid-target');
  });

  it('🔴 YOLO 也拦得住 —— 红线不受档位影响', () => {
    expect(verdict('fs.delete', `${DATA}/audit.db`, 'yolo').effect).toBe('deny');
  });

  it('事件库不在红线内，只需要确认 —— 红线只留"没有正当理由"的操作', () => {
    const v = verdict('fs.delete', `${DATA}/events.db`);
    expect(v.effect).toBe('ask');
  });

  it('数据目录里的其它文件不受影响', () => {
    expect(verdict('fs.write', `${DATA}/blobs/ab/cd`).effect).toBe('ask');
    // `*` 不跨 `/`，所以红线不该顺手把整个目录盖住
    expect(verdict('fs.write', `${DATA}/audit.db.d/x`).effect).toBe('ask');
  });

  /**
   * 反向演练的固化版：`dataDir` 若不是展开后的绝对路径，构造期就必须炸。
   *
   * 演练做法是把 `dataDir` 传成 `~/.local/share/xiaoming`——也就是 ADR-0012 ① 里
   * 那个"红线写 `~`、运行时传 `/home/ming`"的失效原样重放一遍。现在它连规则都建不出来。
   */
  it('🔴 dataDir 传成 ~ 开头的路径 → 构造期直接抛，而不是安静地生成一条永不命中的规则', () => {
    expect(() => builtinRules({ ...ENV, dataDir: '~/.local/share/xiaoming' })).toThrow(/~/);
    expect(() => builtinRules({ ...ENV, dataDir: '.local/share/xiaoming' })).toThrow(/绝对路径/);
  });
});

describe('paths → PolicyEnv 只有一条通路', () => {
  it('policyEnvFromPaths 整份转换，不给"手写一半"留缝', () => {
    const paths: XmPaths = {
      home: '/home/ming',
      appRoot: '/repo',
      data: DATA,
      config: '/home/ming/.config/xiaoming',
      cache: '/home/ming/.cache/xiaoming',
      logs: '/home/ming/.local/state/xiaoming',
    };
    expect(policyEnvFromPaths(paths)).toEqual(ENV);
  });

  it('红线与存储适配器用的是同一份文件名定义', () => {
    const layout = xmDataLayout(DATA);
    expect(layout.auditDb).toBe(`${DATA}/audit.db`);
    expect(layout.eventsDb).toBe(`${DATA}/events.db`);
    expect(layout.blobsDir).toBe(`${DATA}/blobs`);
    // 一边写 audit.db、另一边打开 audit.sqlite —— 红线就会安静地护住一个不存在的文件
    expect(verdict('fs.delete', layout.auditDb).effect).toBe('deny');
  });

  it('Windows 路径经同一次规范化后仍然命中', () => {
    const winData = 'C:\\Users\\ming\\AppData\\Roaming\\xiaoming';
    const rules = builtinRules({
      home: 'C:/Users/ming',
      appRoot: 'C:/repo',
      dataDir: winData,
    });
    const v = evaluate({
      request: req('fs.delete', 'c:\\users\\ming\\appdata\\roaming\\xiaoming\\audit.db-wal'),
      rules,
      tier: 'balanced',
      pathCaseInsensitive: true,
    });
    expect(v.effect).toBe('deny');
  });
});
