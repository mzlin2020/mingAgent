import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistedEvent, PolicyRuleSet } from '@xm/contracts';
import { newRequestId, newSessionId } from '@xm/contracts';
import type { RuleLayer, XmPaths } from '@xm/kernel';
import { MemoryEventStore, composeRules, evaluate, policyEnvFromPaths } from '@xm/kernel';
import { EventBus, SessionRuntime } from '@xm/runtime';
import { createSessionPolicy } from '../src/main/session-policy.js';

/**
 * 🔴 项目层权限规则必须锚在**会话的工作目录**上（地基复审四 B1）。
 *
 * 桌面装配过去按 `app.getPath('home')` 加载项目层，于是用户真正打开的那个仓库里的
 * `.xiaoming/config.json` 从未生效过一次——而 `packages/platform` 的用例全绿，
 * 因为它们直接给 `loadConfig({ cwd })` 传对了目录。**错的不是加载器，是调用方给的锚点。**
 *
 * 所以这里测的是装配那一侧：给两个不同工作目录的会话，看它们各自拿到的规则层。
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(rules?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xm-session-policy-'));
  roots.push(root);
  if (rules !== undefined) {
    await mkdir(join(root, '.xiaoming'), { recursive: true });
    await writeFile(
      join(root, '.xiaoming', 'config.json'),
      JSON.stringify({ permission: { rules } }),
      'utf8',
    );
  }
  return root;
}

const pathsIn = (home: string): XmPaths => ({
  home,
  sourceRoot: join(home, 'not-a-checkout'),
  data: join(home, 'data'),
  config: join(home, 'config'),
  cache: join(home, 'cache'),
  logs: join(home, 'logs'),
});

async function openSession(
  cwd: string,
): Promise<{ runtime: SessionRuntime; events: () => Promise<PersistedEvent[]> }> {
  const store = new MemoryEventStore();
  const sessionId = newSessionId();
  const runtime = await SessionRuntime.open({ sessionId, store, bus: new EventBus() });
  await runtime.record({ type: 'session.created', payload: { cwd, modelRef: 'scripted/x' } });
  return {
    runtime,
    events: async () => {
      const out: PersistedEvent[] = [];
      for await (const e of store.read(sessionId)) out.push(e);
      return out;
    },
  };
}

const DENY_READ: PolicyRuleSet = [
  {
    id: 'project.no-read-secrets',
    effect: 'deny',
    capability: 'fs.read',
    match: { target: '**/secrets/**' },
    reason: '这个仓库不许读 secrets/',
    immutable: false,
  },
];

const verdictOf = (layers: readonly RuleLayer[], target: string) =>
  evaluate({
    layers,
    executor: 'local',
    request: {
      requestId: newRequestId(),
      sessionId: newSessionId(),
      capability: 'fs.read',
      target,
      risk: 'medium',
      reason: '用例',
      trustLevel: 'model',
    },
  });

describe('🔴 会话级规则层：项目层按工作目录加载', () => {
  it('工作区里的 .xiaoming/config.json 真的生效了', async () => {
    const home = await workspace();
    const project = await workspace(DENY_READ);
    const paths = pathsIn(home);
    const layers = composeRules({ env: policyEnvFromPaths(paths), user: [] });
    const policy = createSessionPolicy({ paths, current: () => ({ layers, userRules: [] }) });

    const { runtime } = await openSession(project);
    const got = await policy.layersFor(runtime);

    expect(verdictOf(got, join(project, 'secrets', 'k.txt')).effect).toBe('deny');
    // 对照：不带项目配置的那个会话，同一个目标照常放行
    const other = await openSession(home);
    expect(verdictOf(await policy.layersFor(other.runtime), join(project, 'secrets', 'k.txt')).effect).toBe(
      'allow',
    );
  });

  it('🔴 项目层只能收紧：仓库里写的 allow 被丢弃，且会话里留下一条 notice', async () => {
    const home = await workspace();
    const project = await workspace([
      {
        id: 'project.allow-everything',
        effect: 'allow',
        capability: 'fs.write',
        match: { target: '**' },
        reason: '仓库作者想放开写',
        immutable: false,
      },
    ]);
    const paths = pathsIn(home);
    const layers = composeRules({ env: policyEnvFromPaths(paths), user: [] });
    const policy = createSessionPolicy({ paths, current: () => ({ layers, userRules: [] }) });

    const { runtime, events } = await openSession(project);
    const got = await policy.layersFor(runtime);

    // 放松的条目被丢掉 → 层里一条项目规则都不剩，于是就是全局那一套
    expect(got).toBe(layers);
    const notices = (await events()).flatMap((e) => (e.type === 'notice.posted' ? [e.payload] : []));
    expect(notices[0]?.code).toBe('config.project_rules_dropped');
    expect(notices[0]?.message).toContain('只能收紧');
  });

  it('没有项目配置、也不是小明的检出 → 直接复用全局层，不重算', async () => {
    const home = await workspace();
    const plain = await workspace();
    const paths = pathsIn(home);
    const layers = composeRules({ env: policyEnvFromPaths(paths), user: [] });
    const policy = createSessionPolicy({ paths, current: () => ({ layers, userRules: [] }) });

    const { runtime } = await openSession(plain);
    expect(await policy.layersFor(runtime)).toBe(layers);
  });

  it('按会话缓存：每回合都要用它，但磁盘只读一次、notice 也只落一次', async () => {
    const home = await workspace();
    const project = await workspace([
      ...DENY_READ,
      {
        id: 'project.allow-everything',
        effect: 'allow',
        capability: 'fs.write',
        match: { target: '**' },
        reason: '会被丢掉的那条',
        immutable: false,
      },
    ]);
    const paths = pathsIn(home);
    let layers = composeRules({ env: policyEnvFromPaths(paths), user: [] });
    const policy = createSessionPolicy({ paths, current: () => ({ layers, userRules: [] }) });

    const { runtime, events } = await openSession(project);
    const first = await policy.layersFor(runtime);
    expect(await policy.layersFor(runtime)).toBe(first);
    expect(await policy.layersFor(runtime)).toBe(first);
    // 三次调用，一条 notice——否则每个回合都会往会话里刷一遍同样的警告
    expect((await events()).filter((e) => e.type === 'notice.posted')).toHaveLength(1);

    // 设置里改了权限规则 → 全局层换了个对象，会话级那份必须跟着作废
    layers = composeRules({ env: policyEnvFromPaths(paths), user: [] });
    policy.invalidate();
    expect(await policy.layersFor(runtime)).not.toBe(first);
    expect(verdictOf(await policy.layersFor(runtime), join(project, 'secrets', 'k.txt')).effect).toBe(
      'deny',
    );
  });
});
