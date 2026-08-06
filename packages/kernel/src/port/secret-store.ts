import type { SecretRef } from '@xm/contracts';
import type { SecretBackend } from './platform.js';

/**
 * 密钥存储端口。
 *
 * 内核零 I/O，所以这里只有类型；三个实现分别在 `@xm/platform`（文件口令加密、
 * 不可用兜底）与 `apps/desktop`（Electron safeStorage）。这与 `PlatformPort`
 * 的分工完全一致：**能力往上抬，不往下修**（ADR-0007 保险 2）。
 *
 * ── 三条写进接口形状里的规定 ──
 *
 * **一、`list()` 只返回条目名，永远不返回值。** 一个"把所有密钥读出来"的调用
 * 迟早会被某处日志、某个调试面板、某次序列化顺手用上。让它在类型上就不存在。
 *
 * **二、`backend` 是只读事实，不是配置。** 它由运行环境探测得来（`safeStorage`
 * 可不可用），调用方不能"设置"它。UI 要靠它决定显不显示降级横幅。
 *
 * **三、`set()` 在 `plaintext-unavailable` 下必须抛。** 不是返回 false ——
 * 返回值可以被忽略，而"存密钥失败了但程序继续跑"意味着用户以为自己存上了。
 * `secret.ts` 那句「绝不静默明文」的可执行形式就是这一条。
 */
export interface SecretStore {
  readonly backend: SecretBackend;

  /** 取不到返回 `undefined`，不抛——"还没配置"是正常状态，不是错误 */
  get(ref: SecretRef): Promise<string | undefined>;

  /** 后端不可用时**抛**，不静默降级（见上面第三条） */
  set(ref: SecretRef, value: string): Promise<void>;

  /** 幂等：删一个不存在的条目不算错 */
  delete(ref: SecretRef): Promise<void>;

  /** **只有条目名**。故意没有 `entries()` / `getAll()` */
  list(): Promise<readonly string[]>;
}

/**
 * 后端不可用时 `set()` 抛的错。
 *
 * 单独一个类型，是为了让外壳能把它与"钥匙串里没这条"区分开：
 * 前者要显示一段解释怎么装 keyring 的话，后者只要弹录入框。
 */
export class SecretUnavailableError extends Error {
  readonly backend: SecretBackend;
  constructor(backend: SecretBackend, message: string) {
    super(message);
    this.name = 'SecretUnavailableError';
    this.backend = backend;
  }
}
