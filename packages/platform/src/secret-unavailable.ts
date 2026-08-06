import type { SecretStore } from '@xm/kernel';
import { SecretUnavailableError } from '@xm/kernel';

/**
 * 两种后端都不可用时的 SecretStore（`SecretBackend = 'plaintext-unavailable'`）。
 *
 * ── 它存在的全部意义是：`set()` 会抛 ──
 *
 * 参考项目那个含真实 API key 且已提交进 git 的 `config.yaml`，不是某个人某天疏忽写出来的，
 * 而是"当时没有别的地方可以放"的必然结果。**只要存在一条"先明文存着，回头再说"的路径，
 * 它就会被走。**
 *
 * 所以这里不提供那条路径：存不了就是存不了，报错里说清楚怎么让它能存。
 * 用户可以选择装 keyring、或者设一个口令走加密文件——两条路都比明文强，
 * 而且都是用户明确选的。
 */
export function unavailableSecretStore(reason?: string): SecretStore {
  const detail = reason === undefined ? '' : `（${reason}）`;

  /*
   * 返回一个 rejected promise，而不是同步 throw。
   *
   * 同步抛的话，`store.set(...)` 会在**表达式求值时**炸掉——调用方写
   * `await store.set(...)` 时看起来一样，但 `.catch()` 挂不上、
   * `Promise.allSettled` 也收不住。接口声明的是 `Promise<void>`，
   * 那它在任何失败路径上都必须真的是一个 promise。
   */
  const fail = (): Promise<never> =>
    Promise.reject(
      new SecretUnavailableError(
      'plaintext-unavailable',
      `当前环境无法安全保存密钥${detail}。\n` +
        '两个可选做法：\n' +
        '  · 安装并启动系统钥匙串（Linux 上通常是 gnome-keyring 或 kwallet）\n' +
        '  · 或设置一个主口令，改用加密文件保存\n' +
          '在此之前不会保存任何密钥——明文落盘不是一个选项。',
      ),
    );

  return {
    backend: 'plaintext-unavailable',

    /*
     * `get` 返回 undefined 而不是抛。
     *
     * 与 `set` 的不对称是刻意的：读不到只是"没配置"，是个正常状态，上层照常引导录入；
     * 而写不了是一件必须当场打断的事——静默失败会让用户以为存上了。
     */
    get(): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    set(): Promise<void> {
      return fail();
    },
    delete(): Promise<void> {
      // 删一个存不了的东西：无事发生，且不该报错
      return Promise.resolve();
    },
    list(): Promise<readonly string[]> {
      return Promise.resolve([]);
    },
  };
}
