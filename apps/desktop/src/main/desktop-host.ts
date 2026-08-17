import { app, safeStorage } from 'electron';
import { dirname, join } from 'node:path';
import type { Profile } from '@xm/compose';
import type {
  AnyEvent,
  BlobRef,
  CallId,
  CheckpointId,
  CheckpointManifestV2,
  Config,
  ContentBlock,
  ContextOccupancy,
  PolicyRuleSet,
  SessionId,
  ToolCardPair,
  XmEvent,
} from '@xm/contracts';
import { Config as ConfigSchema } from '@xm/contracts';
import type { CodeDispatchView } from '../shared/code-dispatch.js';
import { toDispatchView } from '../shared/code-dispatch.js';
import type {
  ExtRecordSummary,
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
  projectSessionCards,
  readBlob as readBlobBytes,
  serializeSessionState,
  summarizeExtRecords,
} from '@xm/kernel';
import type { ConfigProblem } from '@xm/platform';
import {
  createLocalClock,
  createLocalIds,
  loadConfig,
  nodePlatform,
  persistProviderConfig,
  persistUserConfigPatch,
  unavailableSecretStore,
  withCapabilities,
} from '@xm/platform';
import type { OpenedStores } from '@xm/storage';
import { openStores } from '@xm/storage';
import type { ProviderStreamStatus } from '@xm/providers';
import type { CardActionRequest, CardActionResult, TurnDeps } from '@xm/runtime';
import {
  Agent,
  recoverInterruptedSubagents,
  runCardAction,
  runSubagentExploration,
} from '@xm/runtime';
import {
  EventBus,
  SessionRuntime,
  abandonOrphanedTurn,
  autoTitleSession,
  resumeTurn,
  runTurn,
  scanForOrphanedSessions,
  synthesizeInterruption,
  textInput,
} from '@xm/runtime';
import {
  createLocalExecutionWorld,
  nodeCheckpointer,
  nodeCheckpointRestorer,
  nodeToolGateway,
} from '@xm/tool-runtime';
import type { ImageAttachment, ListSessionsResult, OrphanedSessionKind, SettingsResult, UpdateSettingsRequest } from '../shared/ipc.js';
import { decodeImageAttachment } from './multimodal-input.js';
import { assembleDesktopProfile } from './desktop-profile.js';
import { createSessionPolicy } from './session-policy.js';
import { keychainSecretStore } from './secrets.js';
import { sessionListStatus } from './session-list-status.js';
import { openProductionTools, type PtySessionEvent } from './production-tools.js';
import { readSettingsSnapshot } from './settings-snapshot.js';
import {
  assertSettingsUpdate,
  buildSettingsPatch,
  nextConfig,
  nextProviders,
  nextUserRules,
} from './settings-update.js';
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
  readonly profile: Profile;
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
  steerUserMessage(sessionId: SessionId, text: string): Promise<string>;
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
  /** `getSessionState` + 全量卡片。渲染层打开会话走这条 */
  readSession(sessionId: SessionId): Promise<ReadSessionPayload>;
  /**
   * 一条工具事件对应的那半张卡片，随事件推给渲染层（ADR-0058）。
   *
   * 同步、只读、不打开会话——事件是从已打开的会话里发出来的，
   * 这里查不到就说明它不是工具事件，返回 `undefined` 即可。
   */
  cardForEvent(event: AnyEvent): ToolCardPair | undefined;
  /**
   * 占用投影随 `message.start` 同行（ContextBuilder 在 pre-step 里刚写完 sidecar）。
   * 其它事件不带——每个 delta 都附一份没有新信息。
   */
  occupancyForEvent(event: AnyEvent): ContextOccupancy | undefined;
  inspectCheckpoint(sessionId: SessionId, checkpointId: CheckpointId): Promise<CheckpointManifestV2>;
  restoreCheckpoint(sessionId: SessionId, checkpointId: CheckpointId): Promise<boolean>;
  /**
   * 卡片动作（ADR-0065）。渲染层送上来的只有"哪次调用、哪个动作、一份闭集内的载荷"，
   * 反查工具、校验载荷、转成一次新的工具调用全在这条路上，且那次调用照常走完整十二步链。
   */
  cardAction(sessionId: SessionId, request: CardActionRequest): Promise<CardActionResult>;
  /** 解除本会话的不可信标记。返回是否真的解除了（没有标记时为 false） */
  clearUntrusted(sessionId: SessionId, reason?: string): Promise<boolean>;
  /** 停止本会话正在跑的这一轮。返回是否真的有东西被停下 */
  interrupt(sessionId: SessionId): boolean;
  status(): Promise<RuntimeStatus>;
  settings(): Promise<SettingsResult>;
  updateSettings(update: UpdateSettingsRequest): Promise<SettingsResult>;
  clearSearchIndex(): Promise<SettingsResult>;
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

/** `readSession` 的返回形状：序列化状态 + 全量卡片 + 插件记录汇总 + 子调用投影 */
export type ReadSessionPayload = SerializedSessionState & {
  readonly cards: readonly (readonly [CallId, ToolCardPair])[];
  readonly extRecords: readonly ExtRecordSummary[];
  readonly dispatches: readonly (readonly [CallId, CodeDispatchView])[];
  readonly occupancy: ContextOccupancy | undefined;
};

/**
 * 当前装着的插件。**插件宿主还没落地（M4），所以它现在恒为空集**——
 * 于是库里出现的任何插件记录都会如实标成"来自未安装的扩展"。
 * 这不是占位符：在没有宿主的今天，那句话本来就是对的。
 */
const INSTALLED_PLUGIN_IDS: ReadonlySet<string> = new Set<string>();

export async function startServices(): Promise<Services> {
  /*
   * 入口位置从 Electron 拿，不在包里猜（ADR-0014）。**但它不是自改红线的锚点**——
   * `app.getAppPath()` 返回的是入口所在目录：开发时是 `apps/desktop`，打包后是
   * `resources/app.asar`，两者都不是小明的源码树。照着它拼 glob，27 条自改红线
   * 就锚在一个不存在的目录上，而所有用例喂的是合成路径，全绿（地基复审四 A1，ADR-0078）。
   *
   * 现在分两件事说：`appPath` 只是入口，源码树由 `findSourceRoot()` 从它往上找；
   * 打包运行时另外把**安装目录整棵树**交出去——asar 里没有源码，
   * 能改的只有可执行文件、原生模块与 asar 本身，而改掉任何一样，清单就都不作数了。
   */
  const base = nodePlatform({
    appPath: app.getAppPath(),
    ...(app.isPackaged ? { installRoot: dirname(process.resourcesPath) } : {}),
  });

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
  const clock = createLocalClock();
  const ids = createLocalIds();
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

  /*
   * **不传 `cwd`**：项目层的锚点是会话的工作目录，而这里是启动，一个会话都还没有。
   * 传 `app.getPath('home')` 的旧写法让"项目层"恒等于家目录下那个多半不存在的文件，
   * 用户真正打开的那个仓库里的 `.xiaoming/config.json` 从未生效过（地基复审四 B1）。
   * 权限规则那一半现在由 `sessionPolicy` 按会话加载。
   */
  const loaded = await loadConfig({ paths });
  let config: Config = loaded.config;

  /*
   * 规则层。顺序即优先级，后面的层胜（ADR-0023）。
   *
   * 这里只有内置层与用户级：用户级可以放松也可以收紧。**项目级只能收紧**，
   * 且它属于某一个工作目录，所以合在 `sessionPolicy.layersFor()` 里。
   */
  let userRules: PolicyRuleSet = loaded.permissionRules.user;
  let layers: readonly RuleLayer[] = composeRules({ env: policyEnv, user: userRules });

  /** 会话级规则层：项目层权限规则（B1）+ 工作区里那份小明源码的自改红线（ADR-0078） */
  const sessionPolicy = createSessionPolicy({
    paths,
    current: () => ({ layers, userRules }),
  });

  const tools = new ToolRegistry();

  /*
   * `home` 是给命令参数里的 `~` 用的（ADR-0026）。内核不许展开（零 I/O），
   * 而 `rm -rf ~` 的判定必须建立在展开之后的路径上——不传的话它判成
   * "删一个叫 `~` 的文件"，M1-d DoD 的第一条当场落空。
   */
  const gateway = nodeToolGateway({ home: paths.home });
  const checkpointer = nodeCheckpointer({ blobs: stores.blobs });
  const checkpointRestorer = nodeCheckpointRestorer(stores.blobs);

  const runtimes = new Map<SessionId, SessionRuntime>();
  const agents = new Map<SessionId, Agent>();
  /** 每会话一个 AbortController。它的存在期就是"这一轮正在跑" */
  const running = new Map<SessionId, AbortController>();
  const withExclusiveSessionOperation = async <T>(
    sessionId: SessionId,
    busyMessage: string,
    operation: (controller: AbortController) => Promise<T>,
  ): Promise<T> => {
    if (running.has(sessionId)) throw new Error(busyMessage);
    const controller = new AbortController();
    running.set(sessionId, controller);
    try {
      return await operation(controller);
    } finally {
      if (running.get(sessionId) === controller) running.delete(sessionId);
    }
  };
  /**
   * 后台任务（目前只有会话自动命名）的统一取消源。
   *
   * **刻意不进 `running`**：`running` 的语义是"这一轮正在跑"，`sendUserMessage`
   * 见到它就返回 `'busy'`。把命名任务登记进去，用户的下一条消息就会被自己的
   * 标题生成挡住——那是个纯粹自找的死锁。命名失败/被取消的正确表现是"标题没变"，
   * 不该对主对话有任何影响。
   */
  const background = new AbortController();
  const refreshIndex = (root: string): void => {
    if (root === '') return;
    void stores.index.refresh(root, background.signal).catch((error: unknown) => {
      if (!background.signal.aborted) console.error('后台工作区索引失败：', error);
    });
  };

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
    const created = await composition.container.context.runtime.open({
      sessionId,
      store: stores.events,
      bus,
    });
    runtimes.set(sessionId, created);
    refreshIndex(created.state.cwd);
    await recoverInterruptedSubagents(created, stores.events);
    // PTY 句柄是进程内的：重启后回放出来的会话拿不回原来的终端，只能重新开。
    for (const [ptySessionId] of created.state.ptySessions) {
      if (!toolHost.hasSession(sessionId, ptySessionId)) {
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
  const executor = createLocalExecutionWorld();
  const snapshot = (): Promise<SettingsResult> =>
    readSettingsSnapshot({
      config,
      userRules,
      tools,
      stores,
      platform,
      executor,
      secrets,
      policyEnv,
      secretBackend,
      version: app.getVersion(),
      configProblems: loaded.problems,
    });
  const toolHost = await openProductionTools({
    os: platform.os,
    index: stores.index,
    backgroundSignal: background.signal,
    tempDir: join(paths.cache, 'tools'),
    emitPty: (sessionId, event) => {
      runtimeFor(sessionId)
        .then((runtime) => recordPtyEvent(runtime, event))
        .catch((err: unknown) => { console.error('写入 shell.session 事件失败：', err); });
    },
    updateTodos: async ({ sessionId, todos }) => {
      const runtime = await runtimeFor(sessionId);
      const turnId = runtime.state.activeTurn?.turnId;
      await runtime.record({
        type: 'todo.updated', payload: { todos: [...todos] },
        ...(turnId === undefined ? {} : { turnId }),
      });
    },
    expandResults: {
      blobs: stores.blobs,
      resolveRef: async ({ sessionId, hash }) => {
        const runtime = await runtimeFor(sessionId);
        for await (const event of runtime.read()) {
          if (event.type === 'tool.end' && event.payload.fullRef?.hash === hash) return event.payload.fullRef;
        }
        return undefined;
      },
    },
    editProposals: {
      save: async (sessionId, proposal) => {
        const runtime = await runtimeFor(sessionId);
        const turnId = runtime.state.activeTurn?.turnId;
        await runtime.record({
          type: 'edit.proposed', payload: { proposal },
          ...(turnId === undefined ? {} : { turnId }),
        });
      },
      get: async (sessionId, proposalId) => {
        const runtime = await runtimeFor(sessionId);
        const item = runtime.state.editProposals.find((candidate) => candidate.proposal.proposalId === proposalId);
        return item === undefined
          ? undefined
          : {
              proposal: item.proposal,
              applied: item.appliedAt !== undefined,
              reviewed: item.reviewedAt !== undefined,
            };
      },
      markReviewed: async (sessionId, proposalId, selectedHunkIds) => {
        const runtime = await runtimeFor(sessionId);
        const turnId = runtime.state.activeTurn?.turnId;
        await runtime.record({
          type: 'edit.reviewed', payload: { proposalId, selectedHunkIds: [...selectedHunkIds] },
          ...(turnId === undefined ? {} : { turnId }),
        });
      },
      markApplied: async (sessionId, proposalId) => {
        const runtime = await runtimeFor(sessionId);
        const turnId = runtime.state.activeTurn?.turnId;
        await runtime.record({
          type: 'edit.applied', payload: { proposalId },
          ...(turnId === undefined ? {} : { turnId }),
        });
      },
    },
    explore: async (request) => {
      const parentRuntime = await runtimeFor(request.sessionId);
      const ref = modelRefFor('subagent');
      const provider =
        (await providerFor(ref, async (status) => {
          await parentRuntime.record({ type: 'provider.status', payload: status });
        })) ?? onboardingProvider(request.purpose);
      return runSubagentExploration({
        parentRuntime, store: stores.events, bus, parentTools: tools, executor, provider,
        model: provider.id === 'scripted' ? 'scripted-1' : ref.model,
        // 子 Agent 跑在父会话的工作区里，规则层必须是父会话那一套（含项目层与工作区自改红线）
        layers: await sessionPolicy.layersFor(parentRuntime),
        toolAvailability: { executor, platform: platform.capabilities(), disabledTools: config.tools.disabled },
        hostOs: platform.os, gateway, blobs: stores.blobs, prices: config.prices,
        pathCaseInsensitive: platform.os === 'windows',
        inject: async ({ agentId, summary, untrustedContext }) => {
          await agentFor(request.sessionId, parentRuntime).inject({
            content: summary, source: { kind: 'subagent', agentId },
            ...(untrustedContext === undefined ? {} : { untrustedContext }),
          });
        },
      }, request);
    },
  });
  const composition = await assembleDesktopProfile({
    configDir: paths.config,
    clock,
    ids,
    executor,
    policy: layers,
    gateway,
    checkpointer,
    checkpointRestorer,
    secrets,
    tools,
    createTools: () => toolHost.tools,
    builtinToolsAvailable: toolHost.available,
  });

  /**
   * 角色 → 模型引用（docs/08 M3 的"角色路由"在这里落下第一个真实消费者）。
   *
   * `summarize` 没配就**回落到 `main`**，而不是在 `DEFAULT_CONFIG` 里给它塞一个
   * 默认小模型：默认值会绑死某一家，于是只配了另一家 key 的用户会
   * `providerFor()` 返回 `undefined`——自动命名对他永远静默失效，而主对话完全正常。
   * "对所有人都能用、对某些人略贵"是可接受的降级；"对一部分人更便宜、对另一部分人
   * 静默失效"不是。`summarize` 保持纯 opt-in。
   */
  const modelRefFor = (role: 'main' | 'summarize' | 'subagent'): { provider: string; model: string } =>
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
    signal: AbortSignal,
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
        executor,
        platform: platform.capabilities(),
        disabledTools: config.tools.disabled,
      },
      layers: await sessionPolicy.layersFor(runtime),
      executor,
      model: provider.id === 'scripted' ? 'scripted-1' : model,
      hostOs: platform.os,
      prices: config.prices,
      gateway,
      checkpointer,
      blobs: stores.blobs,
      pathCaseInsensitive: platform.os === 'windows',
      signal,
      extensions: composition.container.context.turnExtensions,
      // Code Mode：没装那一行就整个缺席，run_code 拿不到跑程序的地方（ADR-0072）
      ...(composition.container.context.has('codeRuntime')
        ? { codeRuntime: composition.container.context.codeRuntime }
        : {}),
      toolPresentation: config.tools.presentation,
    };
  };

  const agentFor = (sessionId: SessionId, runtime: SessionRuntime): Agent => {
    const existing = agents.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Agent({
      runtime,
      drive: async (input, context) => {
        const echo = input
          .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        const deps = await buildTurnDeps(sessionId, runtime, context.signal, echo);
        return runTurn({ ...deps, inbox: context.inbox }, input);
      },
      onActive: (controller) => running.set(sessionId, controller),
      onIdle: (controller) => {
        if (running.get(sessionId) === controller) running.delete(sessionId);
      },
    });
    agents.set(sessionId, created);
    return created;
  };

  return {
    profile: composition.profile,
    platform,
    stores,
    bus,
    get layers() {
      return layers;
    },
    tools,

    async createSession(options: { title?: string; cwd?: string } = {}): Promise<SessionId> {
      const cwd = options.cwd ?? workspaceForNewSession(config, app.getPath('home'));
      const sessionId = ids.session();
      const runtime = await runtimeFor(sessionId);
      await runtime.record({
        type: 'session.created',
        payload: {
          // 工作目录决定"相对路径相对谁"。用户没选就用家目录——那是个安全的默认值，
          // 但主 DoD 任务（"读这个目录"）需要他先选一个
          cwd,
          modelRef: config.model.main,
          ...(options.title === undefined ? {} : { title: options.title }),
        },
      });
      refreshIndex(runtime.state.cwd);

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
      /*
       * 子 Agent 会话不进用户的会话列表（ADR-0049 补记）。
       *
       * `agent.explore` 每次派生都建一条真实会话，带 `parentSessionId`。原来这里不过滤，
       * 于是 Home 列表里会不断堆出「子 Agent：…」——那是内部执行细节，不是用户的对话。
       * 它们仍然完整落在事件库里，子轨迹照旧可以单独诊断（ADR-0049 §3）。
       */
      return list
        .filter((s) => s.parentSessionId === undefined)
        .map((s) => ({
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
      const agent = agentFor(sessionId, runtime);
      if (running.has(sessionId) && agent.idle) return 'busy';

      // 图片在前、文字在后——已知的简化，等 UI 支持交替插入再放开（docs/08 M1-d）
      const blocks: ContentBlock[] = [];
      for (const img of images ?? []) {
        const { bytes, mime, name } = decodeImageAttachment(img);
        blocks.push({ type: 'image', source: await stores.blobs.put(bytes, mime, name) });
      }
      if (text.trim() !== '') blocks.push({ type: 'text', text });

      const dispatched = agent.followup(blocks);
      if (!dispatched.awakened) return 'queued';
      // 必须在 turn.start 之前求判据；Agent 的 drive 在微任务中开始，当前同步栈仍安全。
      autoTitleInBackground(runtime, text);
      return dispatched.completion;
    },

    async steerUserMessage(sessionId: SessionId, text: string): Promise<string> {
      const runtime = await runtimeFor(sessionId);
      const agent = agentFor(sessionId, runtime);
      if (running.has(sessionId) && agent.idle) return 'busy';
      const dispatched = agent.steer(textInput(text));
      return dispatched.awakened ? dispatched.completion : 'queued';
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
        const deps = await buildTurnDeps(sessionId, runtime, controller.signal);
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
     * 打开会话：状态 + 全量卡片。
     *
     * 卡片在这里算而不是让渲染层自己算，是因为投影函数含在工具定义里、跨不了进程
     * （`kernel/tool/present.ts`）。它是一次 O(工具调用数) 的纯函数遍历，
     * **不重放事件流**——`runtime.state` 本来就已经 reduce 好了。
     */
    async readSession(sessionId: SessionId): Promise<ReadSessionPayload> {
      const runtime = await runtimeFor(sessionId);
      /*
       * 插件记录走一次按类型过滤的读，而不是往 `SessionState` 里加字段（ADR-0057 §三）。
       * 子调用投影同一次读（`tool.code.dispatch`）：`reduce()` 对它只推进 lastSeq
       * （ADR-0072），详情栏又必须能按 callId 拿到入参，所以跟 extRecords 走同一条路。
       */
      const extraEvents: XmEvent[] = [];
      for await (const e of runtime.read({ types: ['ext.persisted', 'tool.code.dispatch'] })) {
        extraEvents.push(e);
      }
      const extEvents = extraEvents.filter((e) => e.type === 'ext.persisted');
      const dispatches = extraEvents.flatMap((e) => {
        if (e.type !== 'tool.code.dispatch') return [];
        const view = toDispatchView(e.payload);
        return [[view.callId, view] as const];
      });
      return {
        ...serializeSessionState(runtime.state),
        cards: [...projectSessionCards(runtime.state, tools).entries()],
        extRecords: summarizeExtRecords(extEvents, INSTALLED_PLUGIN_IDS),
        dispatches,
        occupancy: runtime.occupancy,
      };
    },

    async inspectCheckpoint(
      sessionId: SessionId,
      checkpointId: CheckpointId,
    ): Promise<CheckpointManifestV2> {
      const runtime = await runtimeFor(sessionId);
      const checkpoint = runtime.state.checkpoints.find((item) => item.checkpointId === checkpointId);
      if (checkpoint?.manifestRef === undefined) throw new Error('该还原点没有可读取的 v2 manifest。');
      return checkpointRestorer.inspect(checkpoint.manifestRef);
    },

    async restoreCheckpoint(sessionId: SessionId, checkpointId: CheckpointId): Promise<boolean> {
      return withExclusiveSessionOperation(
        sessionId,
        '会话仍在运行，不能同时恢复文件。',
        async (controller) => {
          const runtime = await runtimeFor(sessionId);
          const checkpoint = runtime.state.checkpoints.find(
            (item) => item.checkpointId === checkpointId,
          );
          if (checkpoint === undefined) throw new Error('找不到该还原点。');
          if (checkpoint.restoredAt !== undefined) return false;
          if (checkpoint.kind !== 'fs' || checkpoint.manifestRef === undefined) {
            throw new Error('该还原点不支持文件系统恢复。');
          }

          await runtime.record({
            type: 'checkpoint.restore.started',
            payload: { checkpointId },
          });
          try {
            await checkpointRestorer.restore(checkpoint.manifestRef, controller.signal);
            await runtime.record({ type: 'checkpoint.restored', payload: { checkpointId } });
            return true;
          } catch (error) {
            await runtime.record({
              type: 'checkpoint.restore.failed',
              payload: {
                checkpointId,
                message: error instanceof Error ? error.message : String(error),
              },
            });
            throw error;
          }
        },
      );
    },

    cardForEvent(event) {
      if (event.type !== 'tool.start' && event.type !== 'tool.end') return undefined;
      const state = runtimes.get(event.sessionId)?.state;
      if (state === undefined) return undefined;
      const card = projectSessionCards(state, tools).get(event.payload.callId);
      if (card === undefined) return undefined;
      // 只送这条事件对应的那一半：挂起卡片在 tool.start，完成卡片在 tool.end
      return event.type === 'tool.start'
        ? { ...(card.call === undefined ? {} : { call: card.call }) }
        : { ...(card.result === undefined ? {} : { result: card.result }) };
    },

    occupancyForEvent(event) {
      if (event.type !== 'message.start') return undefined;
      return runtimes.get(event.sessionId)?.occupancy;
    },

    async cardAction(sessionId, request) {
      return withExclusiveSessionOperation(
        sessionId,
        '会话仍在运行，不能同时执行卡片动作。',
        async (controller) => {
          const runtime = await runtimeFor(sessionId);
          const deps = await buildTurnDeps(sessionId, runtime, controller.signal);
          return runCardAction(deps, request);
        },
      );
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
      const agent = agents.get(sessionId);
      if (agent?.idle === false) return agent.interrupt();
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
      const availabilityBase = { cwd: paths.home, executor, platform: platform.capabilities() };
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

    async settings(): Promise<SettingsResult> {
      return snapshot();
    },

    async updateSettings(update: UpdateSettingsRequest): Promise<SettingsResult> {
      assertSettingsUpdate(update);
      const knownTools = new Set(tools.descriptors().map((tool) => tool.name));
      const nextProv = nextProviders(config.providers, update.providers);
      const nextRules = nextUserRules(userRules, update.permissionDenies);
      let nextLayers: readonly RuleLayer[];
      try {
        nextLayers = composeRules({ env: policyEnv, user: nextRules });
      } catch (cause) {
        const error = new Error(cause instanceof Error ? cause.message : String(cause));
        error.name = 'settings.invalid';
        throw error;
      }
      const next = nextConfig(config, update, nextProv, knownTools);
      ConfigSchema.parse(next);
      await persistUserConfigPatch(
        paths,
        buildSettingsPatch(config, update, nextProv, nextRules, knownTools),
      );
      config = next;
      userRules = nextRules;
      layers = nextLayers;
      // 会话级规则层是按 layers/userRules 合出来的，规则一变就全部作废（ADR-0078 / B1）
      sessionPolicy.invalidate();
      return snapshot();
    },

    async clearSearchIndex(): Promise<SettingsResult> {
      await stores.index.clear();
      return snapshot();
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
      toolHost.dispose();
      for (const runtime of runtimes.values()) await runtime.close();
      runtimes.clear();
      await composition.dispose();
      await stores.close();
    },
  };
}

function workspaceForNewSession(config: Config, home: string): string {
  if (config.workspace.mode === 'home') return home;
  if (config.workspace.mode === 'fixed' && config.workspace.defaultPath !== undefined) {
    return config.workspace.defaultPath;
  }
  const error = new Error('请先选择这个任务的工作目录。');
  error.name = 'WorkspaceRequiredError';
  throw error;
}
