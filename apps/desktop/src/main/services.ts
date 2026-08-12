import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import type { BlobRef, Config, ContentBlock, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type {
  OrphanedTurn,
  PlatformPort,
  RuleLayer,
  SecretBackend,
  SecretStore,
  SerializedSessionState,
} from '@xm/kernel';
import {
  ToolRegistry,
  composeRules,
  detectOrphanedTurn,
  policyEnvFromPaths,
  readBlob as readBlobBytes,
  serializeSessionState,
} from '@xm/kernel';
import type { ConfigProblem } from '@xm/platform';
import {
  loadConfig,
  nodePlatform,
  persistProviderConfig,
  unavailableSecretStore,
  withCapabilities,
} from '@xm/platform';
import type { OpenedStores } from '@xm/storage';
import { openStores } from '@xm/storage';
import type { ProviderStreamStatus } from '@xm/providers';
import type { TurnDeps } from '@xm/runtime';
import {
  EventBus,
  SessionRuntime,
  abandonOrphanedTurn,
  autoTitleSession,
  resumeTurn,
  runTurn,
  scanForOrphanedSessions,
  synthesizeInterruption,
} from '@xm/runtime';
import type { PtySessionEvent } from '@xm/tools-core';
import { PtySessionManager, nodeCheckpointer, nodeToolGateway } from '@xm/tools-core';
import type { ImageAttachment, ListSessionsResult, OrphanedSessionKind } from '../shared/ipc.js';
import { decodeImageAttachment } from './multimodal-input.js';
import { keychainSecretStore } from './secrets.js';
import { sessionListStatus } from './session-list-status.js';
import { productionTools } from './production-tools.js';
import {
  configuredModelRef,
  guessProviderKind,
  onboardingProvider,
  openConfiguredProvider,
} from './provider-service.js';

/**
 * 主进程的装配。
 *
 * 这个文件是整个应用**唯一**知道"Electron"与"业务"同时存在的地方——
 * 再往下的每一层都不认识 electron（depcruise 强制），再往上的渲染层没有 Node 权限。
 */

export interface RuntimeStatus {
  readonly providerReady: boolean;
  readonly providerId: string;
  readonly model: string;
  readonly secretBackend: SecretBackend;
  readonly hasApiKey: boolean;
  readonly configProblems: readonly ConfigProblem[];
  readonly security: {
    readonly boundary: 'host-autonomous-protected-core';
    readonly osSandbox: false;
    readonly protectedResources: readonly string[];
    readonly enabledTools: readonly string[];
    readonly disabledTools: readonly string[];
    readonly unavailableTools: readonly string[];
    readonly terminalMode: 'controlled-argv-no-stdin';
    readonly logRedaction: true;
  };
}

function recordPtyEvent(runtime: SessionRuntime, event: PtySessionEvent): Promise<unknown> {
  switch (event.type) {
    case 'shell.session.opened':
      return runtime.record(event);
    case 'shell.session.output':
      return runtime.record(event);
    case 'shell.session.command.started':
      return runtime.record(event);
    case 'shell.session.command.finished':
      return runtime.record(event);
    case 'shell.session.closed':
      return runtime.record(event);
  }
}

export interface Services {
  readonly platform: PlatformPort;
  readonly stores: OpenedStores;
  readonly bus: EventBus;
  readonly layers: readonly RuleLayer[];
  readonly tools: ToolRegistry;
  createSession(options?: { title?: string; cwd?: string }): Promise<SessionId>;
  /**
   * 会话列表投影，带一个粗粒度的 `status` 徽标（M1-e 会话列表状态整合）。
   *
   * `status` **纯读** `running`/`orphanedSessions` 两张既有内存 Map 拼出来——
   * 不重放任何事件流，不新增持久化：`running` 存在即"这一轮真的在跑"，
   * `orphanedSessions` 存在即"启动扫描时发现它停在没收尾的回合里"（且尚未被
   * 继续/放弃处理掉）。两者都不命中就是 `idle`。这与 `SerializedSessionStateResult.status`
   * （单会话回放语义，只有打开过的会话才低成本可得）是两个不同粒度的概念，
   * 见 `shared/ipc.ts` 里 `SessionListStatus` 的注释。
   */
  listSessions(): Promise<ListSessionsResult>;
  sendUserMessage(
    sessionId: SessionId,
    text: string,
    images?: readonly ImageAttachment[],
  ): Promise<string>;
  /** 按 `BlobRef` 反查图片字节，编成 data URL。渲染层此前从未反查过 blob 内容 */
  readBlob(ref: BlobRef): Promise<string>;
  /**
   * 会话当前状态的可过 IPC 镜像（ADR-0032，修 G4/G5）。
   *
   * 直接把 `runtimeFor()` 缓存的 `SessionRuntime.state` 序列化过去——**不**重新
   * 读一遍事件流。主进程本来就要维护这份已经 `reduce()` 过的状态，让渲染层
   * 拿现成的，比让它自己重放一遍全部历史（旧行为）省掉一整趟 IPC 全量物化。
   */
  getSessionState(sessionId: SessionId): Promise<SerializedSessionState>;
  /** 解除本会话的不可信标记。返回是否真的解除了（没有标记时为 false） */
  clearUntrusted(sessionId: SessionId, reason?: string): Promise<boolean>;
  /** 停止本会话正在跑的这一轮。返回是否真的有东西被停下 */
  interrupt(sessionId: SessionId): boolean;
  status(): Promise<RuntimeStatus>;
  setApiKey(providerId: string, key: string): Promise<void>;
  /**
   * 崩溃恢复（M1-e，docs/04 §8）。启动时扫描出的、停在没收尾回合里的会话。
   * 只是给渲染层挑文案用的粗粒度分类，处理时会重新在 `runtime.state` 上判一遍
   * （不信任这份扫描时的旧缓存）。
   */
  listOrphanedSessions(): readonly { sessionId: SessionId; kind: OrphanedSessionKind }[];
  /** 继续：合成缺失的收尾事件，再续跑这个回合。返回 false = 扫描缓存已过期，没什么可续的 */
  resumeOrphanedSession(sessionId: SessionId): Promise<boolean>;
  /** 放弃：合成缺失的收尾事件，写 turn.end(reason:'aborted')。语义与停止按钮相同 */
  abandonOrphanedSession(sessionId: SessionId): Promise<boolean>;
  close(): Promise<void>;
}

export async function startServices(): Promise<Services> {
  /*
   * `appRoot` 从 Electron 拿，不在包里猜（ADR-0014）。它进红线：
   * `red.self-modify-*` 全部相对它计算，猜错等于那一组红线保护了一个不存在的目录。
   */
  const base = nodePlatform({ appRoot: app.getAppPath() });

  /*
   * 能力"往上抬"，不是"往下修"（ADR-0007 保险 2）。
   * `@xm/platform` 报的是纯 Node 交付得了的地板，外壳到这里才知道钥匙串到底可不可用。
   * `safeStorage.isEncryptionAvailable()` 在无 keyring 的 Linux 会话里返回 false，
   * 那时后端只能是口令加密文件——**不能退化成明文**，所以三态里没有 plaintext 这一项。
   */
  const secretBackend: SecretBackend = safeStorage.isEncryptionAvailable()
    ? 'keychain'
    : 'plaintext-unavailable';

  const platform = withCapabilities(base, {
    secrets: secretBackend,
    tray: true,
    notifications: true,
  });

  const paths = platform.paths();
  const stores = await openStores(paths);
  const policyEnv = policyEnvFromPaths(paths);
  const bus = new EventBus();

  /*
   * 密钥存储。**没有第三条路**：要么钥匙串，要么明确地存不了。
   *
   * 口令加密文件那一档（`fileSecretStore`）已经实现，但需要一个"设置主口令"的
   * 界面才能用上，而那是配置中心的一部分（M3）。在它出现之前，无钥匙串环境下
   * 正确的行为是**明确拒绝**并告诉用户怎么办——不是找个地方先存着。
   */
  const secrets: SecretStore =
    secretBackend === 'keychain'
      ? keychainSecretStore({ file: join(paths.config, 'secrets.json') })
      : unavailableSecretStore('系统钥匙串不可用');

  const loaded = await loadConfig({ paths, cwd: app.getPath('home') });
  let config: Config = loaded.config;

  /*
   * 规则层。顺序即优先级，后面的层胜（ADR-0023）。
   *
   * 用户级可以放松也可以收紧；**项目级只能收紧**——`.xiaoming/config.json` 躺在
   * 用户 clone 来的仓库里，而小明自己有 `fs.write`。被丢弃的条目进 `problems`，
   * 变成一条用户看得见的 notice：不生效可以，不告诉他不行。
   */
  const layers: readonly RuleLayer[] = composeRules({
    env: policyEnv,
    user: loaded.permissionRules.user,
    project: loaded.permissionRules.project,
  });

  const tools = new ToolRegistry();

  /*
   * `home` 是给命令参数里的 `~` 用的（ADR-0026）。内核不许展开（零 I/O），
   * 而 `rm -rf ~` 的判定必须建立在展开之后的路径上——不传的话它判成
   * "删一个叫 `~` 的文件"，M1-d DoD 的第一条当场落空。
   */
  const gateway = nodeToolGateway({ home: paths.home });
  const checkpointer = nodeCheckpointer({ blobs: stores.blobs });

  const runtimes = new Map<SessionId, SessionRuntime>();
  /** 每会话一个 AbortController。它的存在期就是"这一轮正在跑" */
  const running = new Map<SessionId, AbortController>();
  /**
   * 后台任务（目前只有会话自动命名）的统一取消源。
   *
   * **刻意不进 `running`**：`running` 的语义是"这一轮正在跑"，`sendUserMessage`
   * 见到它就返回 `'busy'`。把命名任务登记进去，用户的下一条消息就会被自己的
   * 标题生成挡住——那是个纯粹自找的死锁。命名失败/被取消的正确表现是"标题没变"，
   * 不该对主对话有任何影响。
   */
  const background = new AbortController();

  /**
   * 崩溃恢复的起始扫描（M1-e，docs/04 §8 步骤 1）。**只读**——`scanForOrphanedSessions`
   * 不 `openForWrite()`，不会跟仍然真的活着的另一个进程抢锁。
   *
   * 扫描一次性做完，结果缓存在这张表里；`resumeOrphanedSession`/`abandonOrphanedSession`
   * 处理时会在真实的 `runtime.state` 上重新判一遍（不信任这份缓存），处理掉的会话
   * 从表里删掉。
   */
  const orphanedSessions = new Map<SessionId, OrphanedTurn>();
  for (const { sessionId, orphan } of await scanForOrphanedSessions(stores.events)) {
    orphanedSessions.set(sessionId, orphan);
  }

  /*
   * ── 这里曾经有一个 `pending: Map<RequestId, resolve>` 与 `denyAllPending()` ──
   *
   * 挂起的审批请求，以及"关窗 / 退出 / 点停止三个地方都必须把它兑现成 deny"这条
   * 一个都不能漏的纪律：漏一个，那个 promise 永远不 resolve，表现是 Turn 循环挂死、
   * 会话卡在 `waiting_permission`，而用户看到的是"点了停止但它还在转"。
   *
   * ADR-0039 之后没有挂起的审批，这个 Map 与它那三处兑现点一起删除。
   * `interrupt()` / `close()` 因此只需要 abort：**没有第二种需要唤醒的等待了。**
   */

  const runtimeFor = async (sessionId: SessionId): Promise<SessionRuntime> => {
    const existing = runtimes.get(sessionId);
    if (existing !== undefined) return existing;
    // 同一会话只允许一个写者（不变量四）：句柄的生命周期就是租约，缓存住它
    const created = await SessionRuntime.open({ sessionId, store: stores.events, bus });
    runtimes.set(sessionId, created);
    // PTY handles are process-local. An opened session replayed after restart cannot be reattached.
    for (const [ptySessionId] of created.state.ptySessions) {
      if (!ptySessions.has(sessionId, ptySessionId)) {
        await created.record({
          type: 'shell.session.closed',
          payload: { ptySessionId, reason: 'interrupted', tail: '' },
        });
      }
    }
    return created;
  };

  /**
   * PTY 会话（`shell.session`，ADR-0031）。全应用共享一个实例，按 `xmSessionId`
   * 分区——一个共享实例按 xm 会话分区，理由见 `pty-session.ts` 顶部注释。
   *
   * `emit` 只管把事实转成一次 `SessionRuntime.record()`，不关心持久化/广播怎么做——
   * 那是 `record()` 自己的事，manager 不重复一份判断。record 失败（会话已关闭之类）
   * 只记日志，不让一次输出块的写入失败拖垮整个 PTY 会话。
   */
  const ptySessions = new PtySessionManager({
    os: platform.os,
    emit: (sessionId, event) => {
      runtimeFor(sessionId)
        .then((runtime) => recordPtyEvent(runtime, event))
        .catch((err: unknown) => {
          console.error('写入 shell.session 事件失败：', err);
        });
    },
  });
  for (const tool of productionTools({ os: platform.os, ptySessions })) tools.register(tool);

  /**
   * 角色 → 模型引用（docs/08 M3 的"角色路由"在这里落下第一个真实消费者）。
   *
   * `summarize` 没配就**回落到 `main`**，而不是在 `DEFAULT_CONFIG` 里给它塞一个
   * 默认小模型：默认值会绑死某一家，于是只配了另一家 key 的用户会
   * `providerFor()` 返回 `undefined`——自动命名对他永远静默失效，而主对话完全正常。
   * "对所有人都能用、对某些人略贵"是可接受的降级；"对一部分人更便宜、对另一部分人
   * 静默失效"不是。`summarize` 保持纯 opt-in。
   */
  const modelRefFor = (role: 'main' | 'summarize'): { provider: string; model: string } =>
    configuredModelRef(config, role);

  const modelRef = (): { provider: string; model: string } => modelRefFor('main');

  /**
   * 按配置造 Provider。**每轮现造，不缓存。**
   *
   * 缓存住一个 Provider 实例意味着用户换了 key 或换了 baseUrl 之后，
   * 直到重启才生效——而"改了配置没反应"是最难自查的一类问题。
   * 造一个实例的成本只是几个字段赋值，没有连接池要复用。
   */
  const providerFor = async (
    ref = modelRef(),
    onStatus?: (status: ProviderStreamStatus) => void | Promise<void>,
  ) =>
    openConfiguredProvider({
      ref,
      config,
      secrets,
      blobs: stores.blobs,
      ...(onStatus === undefined ? {} : { onStatus }),
    });

  /**
   * 会话自动命名（ADR-0038）。**发出去就不管**——命名是后台任务，不该让用户
   * 这一轮多等一次网络往返。
   *
   * ⚠️ **必须在 `runTurn()` 之前调用，而且中间不能隔着 await。** 判据是"messages 里
   * 还没有 user 消息"，而 `runTurn` 记的第一条事件 `turn.start` 就会把用户输入并进
   * messages。`autoTitleSession` 在第一个 await 之前求值判据，所以这里不 await 它没关系。
   *
   * 第一版栽在这条上：先 `await providerFor(ref)`（要读钥匙串）再调命名，判据被推到
   * `turn.start` 之后求值，于是**恒为假**——功能上线后一次都没成功过，全库
   * `session.renamed` 事件数为 0，而且完全静默。所以 `openProvider` 现在是个**工厂**，
   * 由 `session-title.ts` 在判过之后才调它：顺序改由类型保证，这里想写错也写不出来。
   *
   * 判断都在 `@xm/runtime` 的 `session-title.ts` 里（那里有测试，本文件没有）——
   * 这一层只做装配：挑模型、给一把造 Provider 的钥匙、决定失败了怎么说。
   */
  const autoTitleInBackground = (runtime: SessionRuntime, text: string): void => {
    const ref = modelRefFor('summarize');
    void autoTitleSession(
      {
        runtime,
        openProvider: () => providerFor(ref),
        model: ref.model,
        signal: background.signal,
      },
      text,
    ).catch((err: unknown) => {
      // 正常退出时 close() 会 abort 掉它，那不是错误，不该在控制台刷一条吓人的报错
      if (background.signal.aborted) return;
      console.error('会话自动命名失败（不影响本轮对话）：', err);
    });
  };

  /**
   * 组一份 `TurnDeps`——`sendUserMessage`（全新一轮）与 `resumeOrphanedSession`
   * （续跑一个崩溃恢复出来的回合）共用同一套装配，不重复维护两份。
   */
  const buildTurnDeps = async (
    sessionId: SessionId,
    runtime: SessionRuntime,
    controller: AbortController,
    /** 没配置真 Provider 时，兜底的本地回显要说点什么——`sendUserMessage` 传用户刚打的字 */
    demoEcho = '（崩溃恢复续跑，没有新的用户输入）',
  ): Promise<TurnDeps> => {
    const { model } = modelRef();
    const provider =
      (await providerFor(modelRef(), async (status) => {
        await runtime.record({ type: 'provider.status', payload: status });
      })) ?? onboardingProvider(demoEcho);

    return {
      runtime,
      provider,
      tools,
      toolAvailability: {
        executor: 'local',
        platform: platform.capabilities(),
        disabledTools: config.tools.disabled,
      },
      layers,
      model: provider.id === 'scripted' ? 'scripted-1' : model,
      hostOs: platform.os,
      prices: config.prices,
      gateway,
      checkpointer,
      blobs: stores.blobs,
      pathCaseInsensitive: platform.os === 'windows',
      signal: controller.signal,
    };
  };

  return {
    platform,
    stores,
    bus,
    layers,
    tools,

    async createSession(options: { title?: string; cwd?: string } = {}): Promise<SessionId> {
      const sessionId = newSessionId();
      const runtime = await runtimeFor(sessionId);
      await runtime.record({
        type: 'session.created',
        payload: {
          // 工作目录决定"相对路径相对谁"。用户没选就用家目录——那是个安全的默认值，
          // 但主 DoD 任务（"读这个目录"）需要他先选一个
          cwd: options.cwd ?? app.getPath('home'),
          modelRef: config.model.main,
          ...(options.title === undefined ? {} : { title: options.title }),
        },
      });

      /*
       * 降级与配置问题**在会话里留痕**，不只是在界面上闪一下。
       *
       * `config/secret.ts` 写着「SecretStore 退化必须发 notice 事件显式告知，
       * 绝不静默明文」——在此之前没有任何代码会发这条 notice，那句话一直是纸面的。
       * 记进事件流的好处是它会被回放出来：三个月后回看这个会话，
       * 仍然能看到"当时密钥存不了"，而不是对着一堆失败的调用猜。
       */
      if (secretBackend !== 'keychain') {
        await runtime.record({
          type: 'notice.posted',
          payload: {
            level: 'warn',
            code: 'secrets.degraded',
            message:
              '系统钥匙串不可用，当前无法保存 API key（不会退化成明文保存）。' +
              '在 Linux 上通常是缺少 gnome-keyring 或 kwallet。',
          },
        });
      }
      for (const problem of loaded.problems) {
        await runtime.record({
          type: 'notice.posted',
          payload: { level: 'warn', code: problem.code, message: problem.message },
        });
      }

      return sessionId;
    },

    async listSessions(): Promise<ListSessionsResult> {
      const list = await stores.events.listSessions();
      return list.map((s) => ({
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastSeq: s.lastSeq,
        ...(s.title === undefined ? {} : { title: s.title }),
        status: sessionListStatus(s.sessionId, { running, orphaned: orphanedSessions }),
      }));
    },

    async sendUserMessage(
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[],
    ): Promise<string> {
      const runtime = await runtimeFor(sessionId);

      /*
       * 一个会话同时只跑一轮。已经在跑时**拒绝**而不是排队：
       * 排队会让用户连点两次发送后看到两条回复依次出现，而他以为第二次覆盖了第一次。
       */
      if (running.has(sessionId)) return 'busy';

      // 图片在前、文字在后——已知的简化，等 UI 支持交替插入再放开（docs/08 M1-d）
      const blocks: ContentBlock[] = [];
      for (const img of images ?? []) {
        const { bytes, mime, name } = decodeImageAttachment(img);
        blocks.push({ type: 'image', source: await stores.blobs.put(bytes, mime, name) });
      }
      if (text.trim() !== '') blocks.push({ type: 'text', text });

      const controller = new AbortController();
      running.set(sessionId, controller);

      // 必须在 runTurn 之前：turn.start 一落，"这是第一条用户消息"的判据就失真了
      autoTitleInBackground(runtime, text);

      try {
        const deps = await buildTurnDeps(sessionId, runtime, controller, text);
        return await runTurn(deps, blocks);
      } finally {
        running.delete(sessionId);
      }
    },

    /**
     * 崩溃恢复：启动时扫描出的会话列表（只给渲染层挑文案，不带细节）。
     */
    listOrphanedSessions(): readonly { sessionId: SessionId; kind: OrphanedSessionKind }[] {
      return [...orphanedSessions.entries()].map(([sessionId, orphan]) => ({
        sessionId,
        kind: orphan.kind,
      }));
    },

    /**
     * 继续：合成缺失的收尾事件，从崩溃发生的那个迭代边界续跑。
     *
     * 在真实的 `runtime.state` 上重新判一遍 `detectOrphanedTurn`，不信任扫描时的
     * 旧缓存——扫描发生在启动那一刻，用户点"继续"可能是几分钟之后，这中间
     * 会话可能已经被别的入口处理过（比如被另一次 `sendUserMessage` 顶掉——
     * 虽然那要求先手动清掉 pendingPermission，正常操作走不到，但"重新判一遍"
     * 比"信旧缓存"总是更安全）。
     */
    async resumeOrphanedSession(sessionId: SessionId): Promise<boolean> {
      if (!orphanedSessions.has(sessionId)) return false;
      const runtime = await runtimeFor(sessionId);
      const orphan = detectOrphanedTurn(runtime.state);
      orphanedSessions.delete(sessionId);
      if (orphan === undefined) return false;

      if (running.has(sessionId)) return false; // 已经在跑了，不该被崩溃恢复的"继续"再插一脚

      const controller = new AbortController();
      running.set(sessionId, controller);
      try {
        await synthesizeInterruption(runtime, orphan);
        const deps = await buildTurnDeps(sessionId, runtime, controller);
        await resumeTurn(deps, orphan.turnId);
      } finally {
        running.delete(sessionId);
      }
      return true;
    },

    /** 放弃：合成缺失的收尾事件，写 turn.end(reason:'aborted')——与停止按钮同一套语义 */
    async abandonOrphanedSession(sessionId: SessionId): Promise<boolean> {
      if (!orphanedSessions.has(sessionId)) return false;
      const runtime = await runtimeFor(sessionId);
      const orphan = detectOrphanedTurn(runtime.state);
      orphanedSessions.delete(sessionId);
      if (orphan === undefined) return false;

      await abandonOrphanedTurn(runtime, orphan);
      return true;
    },

    async readBlob(ref: BlobRef): Promise<string> {
      const bytes = await readBlobBytes(stores.blobs, ref);
      return `data:${ref.mime};base64,${Buffer.from(bytes).toString('base64')}`;
    },

    async getSessionState(sessionId: SessionId): Promise<SerializedSessionState> {
      const runtime = await runtimeFor(sessionId);
      return serializeSessionState(runtime.state);
    },

    /**
     * 解除不可信标记。外壳这一层**只做转发**——判断与事件都在 `SessionRuntime` 里，
     * 那样 CLI（M3）与 headless 走的是同一段代码，而不是同一段注释。
     */
    async clearUntrusted(sessionId: SessionId, reason?: string): Promise<boolean> {
      const runtime = await runtimeFor(sessionId);
      return runtime.clearUntrusted(reason);
    },

    /**
     * 停止。**同步**，且只做一件事：`abort()`。
     *
     * 不 await 任何东西是刻意的——"200ms 内真停"这条 DoD 里，这一层不能是瓶颈。
     * 真正的停止发生在 `@xm/providers` 的取消桥接里（fetch 的正文读取当场抛错），
     * `message.interrupted` 由 Turn 循环在收尾时落下。
     */
    interrupt(sessionId: SessionId): boolean {
      const controller = running.get(sessionId);
      if (controller === undefined) return false;
      controller.abort();
      return true;
    },

    async status(): Promise<RuntimeStatus> {
      const { provider: providerId, model } = modelRef();
      const provider = await providerFor().catch(() => undefined);
      const cfg = config.providers[providerId];
      const hasApiKey =
        cfg?.apiKey === undefined
          ? false
          : await secrets
              .get(cfg.apiKey)
              .then((value) => value !== undefined)
              .catch(() => false);
      const availabilityBase = { cwd: paths.home, executor: 'local' as const, platform: platform.capabilities() };
      const allTools = tools.descriptors().map((tool) => tool.name);
      const platformAvailable = tools.descriptors({ ...availabilityBase, disabledTools: [] }).map((tool) => tool.name);
      const enabledTools = tools
        .descriptors({ ...availabilityBase, disabledTools: config.tools.disabled })
        .map((tool) => tool.name);
      return {
        providerReady: provider !== undefined,
        providerId,
        model,
        secretBackend,
        hasApiKey,
        configProblems: loaded.problems,
        security: {
          boundary: 'host-autonomous-protected-core',
          osSandbox: false,
          protectedResources: [
            '运行数据、事件库、审计库与 checkpoint/blob',
            '用户配置与密钥存储',
            '权限引擎、能力网关、密钥与脱敏实现',
            '运行时判权入口、关键装配与 CI 护栏',
          ],
          enabledTools: enabledTools.sort(),
          disabledTools: allTools.filter((name) => config.tools.disabled.includes(name)).sort(),
          unavailableTools: allTools.filter((name) => !platformAvailable.includes(name)).sort(),
          terminalMode: 'controlled-argv-no-stdin',
          logRedaction: true,
        },
      };
    },

    /**
     * 录入 API key。
     *
     * 两步：密钥进 SecretStore，**配置里只写引用**。这正是 `SecretRef` 存在的理由——
     * 参考项目那个含真实 key 且已提交进 git 的 `config.yaml`，就是因为当时
     * 没有"只写引用"这条路。
     *
     * SecretRef 与密钥必须一起持久化：只把引用留在内存里会导致重启后“密钥存在但找不到”。
     * 持久化适配器原子替换配置文件，失败时保留原文件，不把损坏配置当作空配置覆盖。
     */
    async setApiKey(providerId: string, key: string): Promise<void> {
      const ref = { $secret: `${providerId}.apiKey` };
      await secrets.set(ref, key);

      const existing = config.providers[providerId];
      const providerConfig = {
        kind: existing?.kind ?? guessProviderKind(providerId),
        ...(existing?.baseUrl === undefined ? {} : { baseUrl: existing.baseUrl }),
        apiKey: ref,
        models: existing?.models ?? [],
      } satisfies Config['providers'][string];
      await persistProviderConfig({ paths, providerId, provider: providerConfig });
      config = {
        ...config,
        providers: {
          ...config.providers,
          [providerId]: providerConfig,
        },
      };
    },

    async close(): Promise<void> {
      // 后台命名任务先停：它不在 running 里，没人替它 abort
      background.abort();
      for (const controller of running.values()) controller.abort();
      running.clear();
      // 应用关闭前先收尾所有还开着的 PTY——不等它们的空闲超时，进程不该在小明退出后还挂着
      ptySessions.disposeAll();
      for (const runtime of runtimes.values()) await runtime.close();
      runtimes.clear();
      await stores.close();
    },
  };
}
