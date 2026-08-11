import { realpath as realpathCb } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PolicyRule } from '@xm/contracts';
import type { PolicyEnv, XmPaths } from '@xm/kernel';
import { appendUserRule, loadConfig } from '@xm/platform';

/**
 * ── 权限规则的分层加载与落盘（ADR-0023）──
 *
 * 两件此前不存在的事在这里被钉住：
 *
 * 一、**权限规则不走配置合并，走分层。** 合并语义里数组是**整体替换**，
 *     于是项目级的 `permission.rules` 会把用户级的整个抹掉——那与"后一层覆盖前一层"
 *     完全不是一回事，而且抹掉的方向恰好是"仓库里的文件干掉了用户的设置"。
 *
 * 二、**「永久授权」要真的能重启后还在。** 这是 M1-c 的 DoD 之一，
 *     而在此之前**没有任何代码写过配置文件**。
 */

let home: string;
let project: string;
let paths: XmPaths;
let env: PolicyEnv;

const configFile = (): string => join(paths.config, 'config.json');

const rule = (over: Partial<PolicyRule> & Pick<PolicyRule, 'id'>): PolicyRule => ({
  effect: 'allow',
  capability: 'fs.write',
  reason: over.id,
  immutable: false,
  ...over,
});

/*
 * ⚠️ `realpath.native`，不是裸的 `mkdtemp`。
 *
 * Windows 上 `os.tmpdir()` 给的是 8.3 短名（`C:\Users\RUNNER~1\AppData\...`），
 * 而内核对短名**失败关闭**：`appendUserRule` 里那道构造期闸门会在 `builtinRules(env)`
 * 就抛出来，五条用例全红，且报的错与它们要测的东西毫无关系。
 *
 * 生产路径上这一步在 `resolvePaths()` 里（platform/paths.ts 的 `resolveWindowsShortName`），
 * 而这个文件手工拼 `XmPaths`，绕过了它。绕过平台层自己的路径解析、又去测平台层的行为，
 * 本身就是这条用例的第一个 bug。
 */
const realNative = promisify(realpathCb.native);

beforeEach(async () => {
  home = await realNative(await mkdtemp(join(tmpdir(), 'xm-cfg-')));
  project = await realNative(await mkdtemp(join(tmpdir(), 'xm-proj-')));
  paths = {
    home,
    appRoot: '/repo',
    data: join(home, 'data'),
    config: join(home, 'config'),
    cache: join(home, 'cache'),
    logs: join(home, 'logs'),
  };
  env = { home, appRoot: '/repo', dataDir: paths.data };
  await mkdir(paths.config, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

const writeUser = (value: unknown): Promise<void> =>
  writeFile(configFile(), JSON.stringify(value), 'utf8');

const writeProject = async (value: unknown): Promise<void> => {
  await mkdir(join(project, '.xiaoming'), { recursive: true });
  await writeFile(join(project, '.xiaoming', 'config.json'), JSON.stringify(value), 'utf8');
};

describe('分层加载', () => {
  it('🔴 用户级与项目级的规则各自成层，不互相抹掉', async () => {
    await writeUser({ permission: { rules: [rule({ id: 'u.one' })] } });
    await writeProject({ permission: { rules: [rule({ id: 'p.one', effect: 'deny' })] } });

    const loaded = await loadConfig({ paths, cwd: project });
    expect(loaded.permissionRules.user.map((r) => r.id)).toEqual(['u.one']);
    expect(loaded.permissionRules.project.map((r) => r.id)).toEqual(['p.one']);
  });

  it('🔴 合并后的 config.permission.rules 恒为空 —— 不留第二份真相', async () => {
    await writeUser({ permission: { rules: [rule({ id: 'u.one' })] } });
    const loaded = await loadConfig({ paths });
    expect(loaded.config.permission.rules).toEqual([]);
  });

  it('🔴 项目层的 allow 被丢弃，并且说出来', async () => {
    await writeProject({
      permission: {
        rules: [rule({ id: 'p.allow' }), rule({ id: 'p.deny', effect: 'deny' })],
      },
    });

    const loaded = await loadConfig({ paths, cwd: project });
    expect(loaded.permissionRules.project.map((r) => r.id)).toEqual(['p.deny']);

    const problem = loaded.problems.find((p) => p.code === 'config.project_rules_dropped');
    expect(problem?.message).toContain('p.allow');
    expect(problem?.message).toContain('只能收紧');
  });

  it('用户层的 allow 保留 —— 那是用户自己的设置', async () => {
    await writeUser({ permission: { rules: [rule({ id: 'u.allow' })] } });
    const loaded = await loadConfig({ paths });
    expect(loaded.permissionRules.user.map((r) => r.id)).toEqual(['u.allow']);
    expect(loaded.problems).toHaveLength(0);
  });

  it('写坏的规则整层丢弃并报出来，但配置的其余部分照常生效', async () => {
    await writeUser({
      model: { main: 'anthropic/claude-opus-5' },
      permission: { rules: [{ id: 'u.bad' }] },
    });

    const loaded = await loadConfig({ paths });
    expect(loaded.permissionRules.user).toEqual([]);
    expect(loaded.problems.map((p) => p.code)).toContain('config.rules_invalid');
    // 模型配置没被这条坏规则连累
    expect(loaded.config.model.main).toBe('anthropic/claude-opus-5');
  });

  it('配置整体不合法时权限规则一并退回空 —— 不在读不懂的文件上做安全判定', async () => {
    await writeUser({ model: 42, permission: { rules: [rule({ id: 'u.one' })] } });
    const loaded = await loadConfig({ paths });
    expect(loaded.permissionRules.user).toEqual([]);
    expect(loaded.problems.map((p) => p.code)).toContain('config.invalid');
  });
});

describe('🔴 永久授权落盘', () => {
  it('写进去之后，重新加载还在 —— 「重启后仍然生效」这句话的全部内容', async () => {
    const grant = rule({
      id: 'grant.always.abc',
      match: { target: join(home, 'work', 'README.md') },
    });
    await appendUserRule({ paths, env, rule: grant });

    const loaded = await loadConfig({ paths });
    expect(loaded.permissionRules.user).toEqual([grant]);
  });

  it('保住文件里其余的内容 —— 只动 permission.rules', async () => {
    await writeUser({
      model: { main: 'x/y' },
      providers: { anthropic: { kind: 'anthropic', apiKey: { $secret: 'anthropic.apiKey' }, models: [] } },
    });
    await appendUserRule({ paths, env, rule: rule({ id: 'grant.always.abc' }) });

    const raw = JSON.parse(await readFile(configFile(), 'utf8')) as Record<string, unknown>;
    expect((raw.model as { main: string }).main).toBe('x/y');
    expect(raw.providers).toBeDefined();
  });

  it('同 id 覆盖而不是重复追加', async () => {
    const a = rule({ id: 'grant.always.abc', match: { target: '/a' } });
    const b = rule({ id: 'grant.always.abc', match: { target: '/b' } });
    await appendUserRule({ paths, env, rule: a });
    await appendUserRule({ paths, env, rule: b });

    const loaded = await loadConfig({ paths });
    expect(loaded.permissionRules.user).toEqual([b]);
  });

  it('🔴 落盘前过构造期闸门 —— 在写下来的那一刻炸，而不是下次启动才失败', async () => {
    await expect(
      appendUserRule({
        paths,
        env,
        // 红线仍然不许建立在命令 target 上（ADR-0026 决策四保留了 ADR-0020 的这一半）
        rule: rule({
          id: 'grant.always.bad',
          capability: 'shell.exec',
          immutable: true,
          match: { target: 'rm -rf /*' },
        }),
      }),
    ).rejects.toThrow(/命令类能力/);

    // 而且**什么都没写下去**
    await expect(readFile(configFile(), 'utf8')).rejects.toThrow();
  });

  it('写入是原子的：不留临时文件', async () => {
    await appendUserRule({ paths, env, rule: rule({ id: 'grant.always.abc' }) });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(paths.config)).filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });
});
