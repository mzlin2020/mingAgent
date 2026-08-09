/**
 * 崩溃恢复的 SIGKILL 姊妹脚本（M1-e，补上一轮记录的已知缺口）。
 *
 * ── 为什么不塞进 `smoke-headless.mjs` ──
 *
 * 那个脚本的职责是"打包产物能不能用"（`exports`/`main` 对不对、原生模块 ABI
 * 编没编好）。这里验证的是完全不同的关注点：`write_leases` 表按死亡 PID
 * 回收陈旧标记那条分支（`isProcessAlive()`，`packages/storage/src/
 * sqlite-event-store.ts`）在**真实跨进程死亡**下的行为——单个 vitest/Node
 * 进程里开两个 `SqliteEventStore` 实例，`pid` 永远是同一个、永远"活着"，
 * 这条分支天生测不到（`apps/desktop/tests/crash-restart.test.ts` 头部注释）。
 *
 * ── 跨平台 ──
 *
 * Node 文档：Windows 没有 POSIX 信号，但 `ChildProcess.kill()` 在 Windows 上
 * 被实现为强制、不可被清理逻辑拦截的终止（效果等价于 SIGKILL）；
 * `process.kill(pid, 0)`（`isProcessAlive()` 依赖的存在性探测）在 Windows 上
 * 同样是纯存在性检查。两条结论合起来，这个脚本理论上不需要按平台分支——
 * `write_leases` 是应用层的表行，不依赖任何 OS 级文件锁自动释放，无论真信号
 * 还是强制终止，对这张表来说都是"进程消失、行还在、需要靠 PID 存活探测回收"。
 * 这一结论未在真实 Windows 机器上跑过，如实标注为残余风险。
 *
 *   node scripts/smoke-write-lease-recovery.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { newSessionId } from '../packages/contracts/dist/index.js';
import { SqliteEventStore } from '../packages/storage/dist/index.js';
import { scanForOrphanedSessions } from '../packages/runtime/dist/index.js';

// fileURLToPath 而不是 `.pathname`：后者在 Windows 上是 `/D:/a/...` 这种带
// 前导斜杠的 URL 路径，不是合法的文件系统路径（同一个坑见 check-file-size.mjs）
const CHILD_SCRIPT = fileURLToPath(new URL('./smoke-write-lease-recovery-child.mjs', import.meta.url));

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const dir = mkdtempSync(join(tmpdir(), 'xm-lease-recovery-'));
const dbPath = join(dir, 'events.sqlite3');
const sessionId = newSessionId();

/** 等子进程 stdout 打出约定的那一行 marker，超时视为子进程没能正常起来 */
function waitForMarker(child, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`等子进程打出 "${marker}" 超时（${String(timeoutMs)}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      buf += String(chunk);
      if (buf.includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程在打出 marker 之前就退出了（code=${String(code)}）`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
}

let child;
let childStderr = '';
try {
  /*
   * stderr 用 'pipe' 而不是 'inherit'——`SIGKILL` 是不可捕获、不可清理的终止，
   * 子进程死前不会再跑任何 JS，但 Node 自己有一条"检测到未落定的顶层 await"的
   * 诊断有时会在这条挂起的 `await new Promise(() => {})` 上打印，跟子进程是否
   * 被杀无关、纯属噪音。缓冲起来，只在真的失败时才打印出来帮助排查。
   */
  child = spawn(process.execPath, [CHILD_SCRIPT, dbPath, sessionId], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    childStderr += String(chunk);
  });

  await waitForMarker(child, 'LEASE_READY', 15_000);

  // ── 杀之前：先证明锁真的生效（反向演练：一次证两头，避免后面的断言是假阳性）──
  {
    const probe = new SqliteEventStore({ path: dbPath });
    try {
      await probe.openForWrite(sessionId);
      fail('子进程还活着的时候，openForWrite 本应抛 WriteLeaseError，实际却成功了——没有对照组，后面的断言没有意义');
    } catch (e) {
      if (e?.name !== 'WriteLeaseError') {
        fail(`子进程还活着时应抛 WriteLeaseError，实际抛的是 ${String(e?.name)}：${String(e?.message)}`);
      }
    } finally {
      await probe.close();
    }
  }

  // ── SIGKILL：等真实的 'exit' 事件，不用 setTimeout 硬等（避免时序 flaky）──
  child.kill('SIGKILL');
  await waitForExit(child);
  child = undefined;

  // ── 杀之后：全新 SqliteEventStore 实例模拟"应用重启后的新进程"──
  const reopened = new SqliteEventStore({ path: dbPath });
  try {
    const writer = await reopened.openForWrite(sessionId);
    await writer.close();
  } catch (e) {
    fail(`死亡 PID 的陈旧写锁没有被回收——重启后仍然拿不到写句柄：${String(e?.message)}`);
  }

  const found = await scanForOrphanedSessions(reopened);
  const mine = found.find((f) => f.sessionId === sessionId);
  if (mine === undefined) {
    fail('重启后的孤儿扫描没有找到这个会话');
  } else if (mine.orphan.kind !== 'message') {
    fail(`孤儿类型应为 message（卡在 message.start，没有 message.end），实际是 ${String(mine.orphan.kind)}`);
  }

  await reopened.close();

  if (process.exitCode !== 1) {
    console.log('✓ 写租约的 SIGKILL 恢复通过：死亡 PID 的陈旧租约被正确回收，孤儿会话被正确识别（M1 DoD ④）');
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  if (process.exitCode === 1 && childStderr !== '') {
    console.error(`── 子进程 stderr（排查用）──\n${childStderr}`);
  }
  // 兜底：任何一步提前失败都不能留下一个僵尸子进程
  if (child !== undefined && !child.killed) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
