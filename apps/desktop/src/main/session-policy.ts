import type { PolicyRuleSet } from '@xm/contracts';
import type { RuleLayer, XmPaths } from '@xm/kernel';
import { composeRules, policyEnvFromPaths } from '@xm/kernel';
import { findSourceRoot, loadProjectPermissionRules } from '@xm/platform';
import type { SessionRuntime } from '@xm/runtime';

/**
 * 会话级规则层。
 *
 * 绝大多数会话用的就是启动时算好的那套全局规则。**工作目录**能改变两件事，
 * 两件都在这里补上，且两件都是复审抓出来的"规则对、锚点错"：
 *
 * 一、**项目层权限规则**（地基复审四 B1）。`.xiaoming/config.json` 躺在会话打开的
 *    那个仓库里，只能收紧（ADR-0023 / `tightenOnly`）。桌面装配过去把它按
 *    `app.getPath('home')` 加载，于是用户真正打开的那个仓库里的项目配置**从未生效过**。
 *
 * 二、**工作区里的那份小明源码**（ADR-0078）。用打包版（或另一个 checkout 的）小明去改一份
 *    clone 下来的源码时，被改的是那一棵树，而自改红线只锚在正在运行的这一棵上。
 *
 * ── 缓存与失效 ──
 *
 * 按会话算一次：`state.cwd` 由 `session.created` 定下来之后不再变，而这里要读磁盘
 * （找源码树标记 + 读项目配置）。缓存的是 **Promise**，并发的第一次打开不会读两遍。
 * 用户在设置里改了权限规则 → `invalidate()` 整体作废（用户层变了，合出来的每一份都变了）。
 *
 * ⚠️ 项目配置在会话开着的时候被改（模型自己有 `fs.write`）不会重新加载。这是有意的：
 * 项目层**只能收紧**，重载只会让"仓库里的文件"能在半途改变判定，而那正是 ADR-0023
 * 要防的东西。想让新的项目规则生效，开一个新会话。
 */
export interface SessionPolicy {
  layersFor(runtime: SessionRuntime): Promise<readonly RuleLayer[]>;
  /** 全局规则变了（设置页写了新的 deny），所有会话级缓存作废 */
  invalidate(): void;
}

export interface SessionPolicyOptions {
  readonly paths: XmPaths;
  /** 当前的全局规则层与用户级规则。取现值，不取快照——设置随时会改它 */
  current(): { readonly layers: readonly RuleLayer[]; readonly userRules: PolicyRuleSet };
}

export function createSessionPolicy(options: SessionPolicyOptions): SessionPolicy {
  const cache = new Map<string, Promise<readonly RuleLayer[]>>();

  const compute = async (runtime: SessionRuntime): Promise<readonly RuleLayer[]> => {
    const cwd = runtime.state.cwd;
    const project = await loadProjectPermissionRules(cwd);

    /*
     * 被丢弃的项目规则要**在会话里留痕**，与配置加载的其它问题同一个姿态：
     * 不生效可以，不告诉他不行（`loadConfig` 的注释里那句话）。
     */
    for (const problem of project.problems) {
      await runtime.record({
        type: 'notice.posted',
        payload: { level: 'warn', code: problem.code, message: problem.message },
      });
    }

    const workspaceRoot = findSourceRoot(cwd);
    const extraSourceRoots =
      workspaceRoot === undefined || workspaceRoot === options.paths.sourceRoot
        ? []
        : [workspaceRoot];

    const { layers, userRules } = options.current();
    // 两件事都没有 → 就是全局那一套，连重算都不必
    if (extraSourceRoots.length === 0 && project.rules.length === 0) return layers;
    return composeRules({
      env: policyEnvFromPaths(options.paths, extraSourceRoots),
      user: userRules,
      project: project.rules,
    });
  };

  return {
    layersFor(runtime) {
      const cached = cache.get(runtime.sessionId);
      if (cached !== undefined) return cached;
      const computed = compute(runtime);
      cache.set(runtime.sessionId, computed);
      return computed;
    },
    invalidate() {
      cache.clear();
    },
  };
}
