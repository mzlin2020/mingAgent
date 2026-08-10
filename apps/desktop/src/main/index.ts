import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, app, dialog } from 'electron';
import { registerIpc } from './ipc.js';
import type { Services } from './services.js';
import { startServices } from './services.js';
import { assertStorageWorks } from './self-check.js';

/**
 * Electron 主进程入口。
 *
 * Agent 循环跑在这里（docs/04 §2）：渲染层崩溃或重载不影响运行中的任务，
 * 关窗到托盘时任务继续跑。渲染层零 Node 权限，只通过 preload 那四个具名调用通信。
 *
 * 应用菜单：ADR-0037 起由渲染层汉堡菜单承接入口，这里去掉默认菜单栏，
 * 避免与自定义壳层重复一整排 File/Edit/View。
 */

const DEV_SERVER = process.env.XM_DEV_SERVER;
const isDev = typeof DEV_SERVER === 'string' && DEV_SERVER !== '';

/**
 * 冒烟模式：不开窗，跑一遍自检与装配就退出。CI 用它验证**打包产物真的能起来**。
 *
 * 为什么必须在 Electron 里跑而不是复用 `scripts/smoke-headless.mjs`：
 * 后者跑在 Node 上、跑的是源码树；这里跑的是 asar 里的产物，
 * 而 M0-b 最可能出问题的恰恰是打包（`prebuilds/` 有没有被 asarUnpack 出来）——
 * 那种问题在源码树上永远看不见。
 */
const isSmoke = process.env.XM_SMOKE === '1';

let services: Services | undefined;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#faf9f5',
    title: '小明',
    webPreferences: {
      /*
       * 三个开关一起才叫隔离，缺一个都等于没开（docs/04 §2）：
       *   contextIsolation  页面脚本与 preload 不共享同一个 JS 世界
       *   nodeIntegration   页面里没有 require / process
       *   sandbox           preload 自己也跑在受限上下文里
       * 最后一个最容易被"为了方便"关掉——关掉之后 preload 能拿到完整 Node，
       * 而 preload 是页面唯一能间接触达的代码。
       */
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
    },
  });

  if (isDev) {
    void win.loadURL(DEV_SERVER);
  } else {
    void win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
  }
  return win;
}

app.whenReady().then(
  async () => {
    /*
     * 自检排在**创建窗口之前**。
     *
     * 顺序有讲究：原生模块坏掉时，先开窗再自检的表现是"窗口起来了、什么都点不动"，
     * 看起来像 UI bug；先自检则是一个说清了原因和修法的错误框。
     * 这类失败在 CI 里是抓不到的——`pnpm test` 跑的是 Node ABI 那一轨（ADR-0016）。
     */
    try {
      await assertStorageWorks();
    } catch (e) {
      dialog.showErrorBox('小明启动失败', e instanceof Error ? e.message : String(e));
      app.exit(1);
      return;
    }

    services = await startServices();

    if (isSmoke) {
      // 走一遍真实的建会话路径：它会打开真库、取写句柄、落一条 session.created。
      // 打包漏了 prebuilds/ 的话，这一步就是崩的那一步。
      const sessionId = await services.createSession({ title: '打包冒烟' });
      const list = await services.stores.events.listSessions();
      const ok = list.some((s) => s.sessionId === sessionId);
      console.log(ok ? '✓ 桌面产物冒烟通过：库能开、会话能建、投影能读' : '✗ 会话没进投影');
      await services.close();
      app.exit(ok ? 0 : 1);
      return;
    }

    registerIpc(services, () => BrowserWindow.getAllWindows());
    // 空菜单 = 无系统菜单栏；会话/设置入口在渲染层 AppMenu（ADR-0037）
    Menu.setApplicationMenu(null);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  },
  (e: unknown) => {
    dialog.showErrorBox('小明启动失败', e instanceof Error ? e.message : String(e));
    app.exit(1);
  },
);

app.on('window-all-closed', () => {
  /*
   * macOS 的习惯是关窗不退出应用；其余平台退出。
   *
   * 平台判断走 `PlatformPort.os`，**不写 `process.platform`**——那条 ESLint 禁令
   * 是全仓库的，主进程也不例外（ADR-0007 保险 1）。这里正是最容易破例的地方：
   * 一句 `=== 'darwin'` 看着无害，但破了例之后就没有下一道防线了。
   * services 还没起来（启动失败）时退出本来就是对的行为。
   */
  if (services?.platform.os !== 'macos') app.quit();
});

app.on('before-quit', () => {
  // 写句柄要显式释放：租约留在库里，下次启动会被当成"别的进程还开着"（ADR-0013 不变量四）
  void services?.close();
});
