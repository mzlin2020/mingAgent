import { createEvent, newSessionId } from '@xm/contracts';
import { sealEvent } from '@xm/kernel';
import { SqliteEventStore } from '@xm/storage';

/**
 * 启动自检：在 Electron 里真的开一次库、写一条、读回来。
 *
 * ── 它防的到底是什么（这条被实测修正过一次）──
 *
 * 原本的说法是"Node ABI 与 Electron ABI 是两轨，所以要防 electron-rebuild 忘了跑"。
 * 2026-08-05 实测下来这个说法**对 better-sqlite3 13 不成立**：它随包发的
 * `prebuilds/<平台>-<架构>.node` 是 **N-API**（导出 `napi_register_module_v1`，
 * 没有 `node_module_register`），而 N-API 的 ABI 在 Node 与 Electron 之间是稳定的，
 * 同一份二进制两边都能加载。详见 ADR-0016。
 *
 * 那自检还有什么用？它防的是**打包**，不是编译：
 *   · electron-builder 的 `files` 漏了 `prebuilds/`，或 asar 把 `.node` 打了进去
 *   · 数据目录在用户机器上不可写
 *   · 将来引入一个**不是 N-API** 的原生依赖，那时两轨问题才真的回来
 *
 * 这三样都有一个共同的表现：窗口起来了、会话列表是空的、点什么都没反应——
 * 看起来像 UI bug，实际是数据库根本没打开。自检把它变成一句说清了原因的错误。
 *
 * 自检故意做在 `:memory:` 上：要验的是**原生模块能不能加载与执行**，
 * 不是磁盘上有什么。它不碰用户数据，也就不会在真库里留下自检产生的垃圾会话。
 */
export async function assertStorageWorks(): Promise<void> {
  const store = new SqliteEventStore({ path: ':memory:' });
  const sessionId = newSessionId();

  try {
    const writer = await store.openForWrite(sessionId);
    await writer.append([
      sealEvent(
        createEvent({
          type: 'session.created',
          sessionId,
          seq: 1,
          ts: Date.now(),
          payload: { cwd: '/', modelRef: 'self-check/none' },
        }),
      ),
    ]);
    await writer.close();

    let count = 0;
    for await (const e of store.read(sessionId)) {
      void e;
      count += 1;
    }
    if (count !== 1) {
      throw new Error(`自检写了 1 条事件，读回 ${String(count)} 条。`);
    }
  } catch (cause) {
    throw new Error(
      '存储自检失败：SQLite 在 Electron 里打不开或读写不一致。\n' +
        '`pnpm test` 全绿并不能排除这件事——测试跑在源码树上，应用跑在打包产物里。\n' +
        '按可能性从高到低查（ADR-0016）：\n' +
        '  1. 打包漏了 better-sqlite3 的 prebuilds/ 目录，或 .node 被打进了 asar\n' +
        '  2. 数据目录不可写\n' +
        '  3. 引入了非 N-API 的原生依赖 —— 那时才需要 electron-rebuild\n' +
        `原始错误：${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  } finally {
    await store.close();
  }
}
