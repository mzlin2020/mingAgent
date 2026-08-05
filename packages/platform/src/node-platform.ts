import type { PlatformCapabilities, PlatformPort, XmPaths } from '@xm/kernel';
import { displayServer, osFamily } from './detect.js';
import type { ResolvePathsOptions } from './paths.js';
import { resolvePaths } from './paths.js';

/**
 * `PlatformPort` 的纯 Node 实现。**不依赖 electron**——CLI（M3）与 headless 冒烟都用它，
 * depcruise 有一条规则专门盯着这件事。
 *
 * ── 能力探测报的是"地板"，不是"天花板" ──
 *
 * 这个适配器只声明**它自己交付得了**的能力。托盘、通知、`safeStorage` 钥匙串都要外壳
 * 才有，所以在这里一律 false / `encrypted-file`；`apps/desktop` 用
 * `withCapabilities()` 往上抬。
 *
 * 反过来做——先乐观声明再由外壳往下修——的问题是：忘了修就是静默的谎报，
 * 而谎报能力的表现是工具出现在模型视野里、调用后才失败。ADR-0007 保险 2
 * 要的是"退化时明确告知"，那前提是没人乐观。
 */
export type NodePlatformOptions = ResolvePathsOptions;

export function nodePlatform(options: NodePlatformOptions): PlatformPort {
  const paths = resolvePaths(options);
  const capabilities = nodeCapabilities();

  return {
    os: osFamily(),
    paths: () => paths,
    capabilities: () => capabilities,
  };
}

function nodeCapabilities(): PlatformCapabilities {
  return {
    /*
     * 纯 Node 下没有 OS 钥匙串，但"用户口令加密的文件"这条路永远走得通，
     * 所以地板是 `encrypted-file` 而不是 `plaintext-unavailable`——后者的含义是
     * **必须拒绝存密钥**，谎报它会让 M1 的 SecretStore 在能干活的环境里罢工。
     * 真正的钥匙串探测在 apps/desktop（`safeStorage.isEncryptionAvailable()`）。
     */
    secrets: 'encrypted-file',
    screenCapture: false,
    // Linux/Wayland 上即便到了 M4 也多半仍是 false（ADR-0007 Tier 3）
    inputInjection: false,
    tray: false,
    notifications: false,
  };
}

/**
 * 在已有 `PlatformPort` 之上覆盖若干能力，路径原样透传。
 *
 * 给 `apps/desktop` 用：Electron 起来之后才知道钥匙串到底可不可用。
 * 做成装饰而不是让 `nodePlatform` 接一堆可选参数，是为了让"谁抬高了哪条能力"
 * 在调用点看得见。
 */
export function withCapabilities(
  base: PlatformPort,
  overrides: Partial<PlatformCapabilities>,
): PlatformPort {
  const merged: PlatformCapabilities = { ...base.capabilities(), ...overrides };
  const paths: XmPaths = base.paths();
  return {
    os: base.os,
    paths: () => paths,
    capabilities: () => merged,
  };
}

export { displayServer };
