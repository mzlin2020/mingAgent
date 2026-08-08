import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import type { BlobRef, Config, ContentBlock, RequestId, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { ModelProvider, PlatformPort, RuleLayer, SecretBackend, SecretStore } from '@xm/kernel';
import { ToolRegistry, composeRules, policyEnvFromPaths, readBlob as readBlobBytes } from '@xm/kernel';
import type { ConfigProblem } from '@xm/platform';
import {
  appendUserRule,
  loadConfig,
  nodePlatform,
  parseModelRef,
  unavailableSecretStore,
  withCapabilities,
} from '@xm/platform';
import { AnthropicProvider, OpenAICompatibleProvider } from '@xm/providers';
import type { OpenedStores } from '@xm/storage';
import { openStores } from '@xm/storage';
import type { PermissionAnswer } from '@xm/runtime';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  echoTool,
  fakeDeleteTool,
  runTurn,
} from '@xm/runtime';
import { PtySessionManager, coreTools, nodeCheckpointer, nodeToolGateway, shellSessionTools } from '@xm/tools-core';
import type { ApprovalMode, ImageAttachment } from '../shared/ipc.js';
import { ApprovalModeStore, TIER_OF } from './approval-mode.js';
import { decodeImageAttachment } from './multimodal-input.js';
import { keychainSecretStore } from './secrets.js';

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
}

export interface Services {
  readonly platform: PlatformPort;
  readonly stores: OpenedStores;
  readonly bus: EventBus;
  readonly layers: readonly RuleLayer[];
  readonly tools: ToolRegistry;
  createSession(options?: { title?: string; cwd?: string }): Promise<SessionId>;
  sendUserMessage(
    sessionId: SessionId,
    text: string,
    images?: readonly ImageAttachment[],
  ): Promise<string>;
  /** 按 `BlobRef` 反查图片字节，编成 data URL。渲染层此前从未反查过 blob 内容 */
  readBlob(ref: BlobRef): Promise<string>;
  /** 解除本会话的不可信标记。返回是否真的解除了（没有标记时为 false） */
  clearUntrusted(sessionId: SessionId, reason?: string): Promise<boolean>;
  /** 停止本会话正在跑的这一轮。返回是否真的有东西被停下 */
  interrupt(sessionId: SessionId): boolean;
  /** 应答一次审批。返回是否对上了一个正在等的请求 */
  respondPermission(requestId: RequestId, answer: PermissionAnswer): boolean;
  /**
   * 本会话当前的审批模式（docs/09 C6）。会话级、不持久化——`createSession` 里
   * 一律初始化成 `'ask'`，不读 `config.json`，也不在这里写它。
   */
  getApprovalMode(sessionId: SessionId): ApprovalMode;
  /** 切换本会话的审批模式，立即对下一次 `sendUserMessage` 生效 */
  setApprovalMode(sessionId: SessionId, mode: ApprovalMode): void;
  status(): Promise<RuntimeStatus>;
  setApiKey(providerId: string, key: string): Promise<void>;
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
  let userRules = [...loaded.permissionRules.user];
  let layers: readonly RuleLayer[] = composeRules({
    env: policyEnv,
    user: userRules,
    project: loaded.permissionRules.project,
  });

  const tools = new ToolRegistry();
  for (const t of coreTools({ os: platform.os })) tools.register(t);
  tools.register(echoTool());
  tools.register(fakeDeleteTool());

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
   * 等待用户应答的审批请求。
   *
   * ── 三个地方必须**兑现成 deny**，一个都不能漏 ──
   *
   * 关窗、退出、点停止。任何一个漏掉，那个 promise 就永远不 resolve——
   * 表现是 Turn 循环挂死、会话卡在 `waiting_permission`，而用户看到的是
   * "点了停止但它还在转"。失败关闭在这里不只是安全姿态，也是不卡死的唯一做法。
   */
  const pending = new Map<RequestId, (answer: PermissionAnswer) => void>();

  const settle = (requestId: RequestId, answer: PermissionAnswer): boolean => {
    const resolve = pending.get(requestId);
    if (resolve === undefined) return false;
    pending.delete(requestId);
    resolve(answer);
    return true;
  };

  const denyAllPending = (): void => {
    for (const requestId of [...pending.keys()]) {
      settle(requestId, { effect: 'deny', scope: 'once' });
    }
  };

  /** 每会话的审批模式（docs/09 C6，ADR-0030）。会话级、不持久化——见 approval-mode.ts */
  const approvalModes = new ApprovalModeStore();

  const runtimeFor = async (sessionId: SessionId): Promise<SessionRuntime> => {
    const existing = runtimes.get(sessionId);
    if (existing !== undefined) return existing;
    // 同一会话只允许一个写者（不变量四）：句柄的生命周期就是租约，缓存住它
    const created = await SessionRuntime.open({ sessionId, store: stores.events, bus });
    runtimes.set(sessionId, created);
    return created;
  };

  /**
   * PTY 会话（`shell.session`，ADR-0031）。全应用共享一个实例，按 `xmSessionId`
   * 分区——与 `ApprovalModeStore` 同一个形状，理由见 `pty-session.ts` 顶部注释。
   *
   * `emit` 只管把事实转成一次 `SessionRuntime.record()`，不关心持久化/广播怎么做——
   * 那是 `record()` 自己的事，manager 不重复一份判断。record 失败（会话已关闭之类）
   * 只记日志，不让一次输出块的写入失败拖垮整个 PTY 会话。
   */
  const ptySessions = new PtySessionManager({
    os: platform.os,
    emit: (sessionId, event) => {
      runtimeFor(sessionId)
        .then((runtime) => runtime.record(event))
        .catch((err: unknown) => {
          console.error('写入 shell.session 事件失败：', err);
        });
    },
  });
  for (const t of shellSessionTools(ptySessions)) tools.register(t);

  const modelRef = (): { provider: string; model: string } => parseModelRef(config.model.main);

  /**
   * 按配置造 Provider。**每轮现造，不缓存。**
   *
   * 缓存住一个 Provider 实例意味着用户换了 key 或换了 baseUrl 之后，
   * 直到重启才生效——而"改了配置没反应"是最难自查的一类问题。
   * 造一个实例的成本只是几个字段赋值，没有连接池要复用。
   */
  const providerFor = async (): Promise<ModelProvider | undefined> => {
    const { provider: providerId, model } = modelRef();
    const cfg = config.providers[providerId];
    if (cfg?.apiKey === undefined) return undefined;

    const apiKey = await secrets.get(cfg.apiKey);
    if (apiKey === undefined || apiKey === '') return undefined;

    const common = {
      apiKey,
      ...(cfg.baseUrl === undefined ? {} : { baseUrl: cfg.baseUrl }),
      ...(cfg.models.length > 0 ? { models: cfg.models } : {}),
      // 图片内容块要靠它把 BlobRef 读成字节再编 base64（见 packages/providers/src/blob.ts）
      blobs: stores.blobs,
    };

    switch (cfg.kind) {
      case 'anthropic':
        return new AnthropicProvider(common);
      case 'openai':
      case 'openai-compatible':
        return new OpenAICompatibleProvider({ ...common, id: providerId });
      default:
        // google / ollama 还没实现。**返回 undefined 而不是悄悄换一家**
        void model;
        return undefined;
    }
  };

  return {
    platform,
    stores,
    bus,
    layers,
    tools,

    async createSession(options: { title?: string; cwd?: string } = {}): Promise<SessionId> {
      const sessionId = newSessionId();
      approvalModes.init(sessionId);
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

    async sendUserMessage(
      sessionId: SessionId,
      text: string,
      images?: readonly ImageAttachment[],
    ): Promise<string> {
      const runtime = await runtimeFor(sessionId);
      const { provider: providerId, model } = modelRef();
      const provider = (await providerFor()) ?? demoProvider(text);

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

      try {
        return await runTurn(
          {
            runtime,
            provider,
            tools,
            layers,
            tier: TIER_OF[approvalModes.get(sessionId)],
            model: provider.id === 'scripted' ? 'scripted-1' : model,
            prices: config.prices,
            gateway,
            checkpointer,
            blobs: stores.blobs,
            pathCaseInsensitive: platform.os === 'windows',
            signal: controller.signal,
            /*
             * 审批：把请求挂起来，等渲染层送答复回来。
             *
             * 挂起期间**不做超时**——用户可能去看代码、去问同事，一个会自己
             * 超时变成拒绝的确认框只会让人养成"赶紧点允许"的习惯。
             * 兜底靠三条兑现路径（关窗 / 退出 / 停止），见 pending 的注释。
             */
            decide: (request) =>
              new Promise<PermissionAnswer>((resolve) => {
                if (controller.signal.aborted) {
                  resolve({ effect: 'deny', scope: 'once' });
                  return;
                }
                pending.set(request.requestId, resolve);
              }),
            /**
             * 「永久」落进用户级配置。
             *
             * 写完之后**立刻重算 layers**：不重算的话，这条规则要等下次启动才生效，
             * 而本会话靠 grants 顶着——两条路径的行为差异会在"重启后范围变了"
             * 这种最难查的形态上暴露出来。
             */
            persistGrant: async (rule) => {
              await appendUserRule({ paths, env: policyEnv, rule });
              userRules = [...userRules.filter((r) => r.id !== rule.id), rule];
              layers = composeRules({
                env: policyEnv,
                user: userRules,
                project: loaded.permissionRules.project,
              });
            },
          },
          blocks,
        );
      } finally {
        running.delete(sessionId);
        // 这一轮结束了，还挂着的审批不可能再有人处理它 —— 兑现成拒绝
        denyAllPending();
        void providerId;
      }
    },

    async readBlob(ref: BlobRef): Promise<string> {
      const bytes = await readBlobBytes(stores.blobs, ref);
      return `data:${ref.mime};base64,${Buffer.from(bytes).toString('base64')}`;
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
      /*
       * 先把挂着的审批兑现成拒绝，再 abort。
       *
       * 顺序要紧：Turn 循环此刻很可能正 await 在 `decide` 上，而 `AbortController`
       * 唤不醒一个普通的 promise。只 abort 不兑现，用户点了停止之后界面会一直转下去。
       */
      denyAllPending();
      controller.abort();
      return true;
    },

    respondPermission(requestId: RequestId, answer: PermissionAnswer): boolean {
      return settle(requestId, answer);
    },

    getApprovalMode(sessionId: SessionId): ApprovalMode {
      return approvalModes.get(sessionId);
    },

    setApprovalMode(sessionId: SessionId, mode: ApprovalMode): void {
      approvalModes.set(sessionId, mode);
    },

    async status(): Promise<RuntimeStatus> {
      const { provider: providerId, model } = modelRef();
      const provider = await providerFor().catch(() => undefined);
      const cfg = config.providers[providerId];
      return {
        providerReady: provider !== undefined,
        providerId,
        model,
        secretBackend,
        hasApiKey: cfg?.apiKey !== undefined,
        configProblems: loaded.problems,
      };
    },

    /**
     * 录入 API key。
     *
     * 两步：密钥进 SecretStore，**配置里只写引用**。这正是 `SecretRef` 存在的理由——
     * 参考项目那个含真实 key 且已提交进 git 的 `config.yaml`，就是因为当时
     * 没有"只写引用"这条路。
     *
     * 配置在内存里更新即可：写回配置文件是配置中心（M3）的事，而那时这段逻辑
     * 会整体搬过去。现在写回去反而会把用户手写的注释与格式冲掉。
     */
    async setApiKey(providerId: string, key: string): Promise<void> {
      const ref = { $secret: `${providerId}.apiKey` };
      await secrets.set(ref, key);

      const existing = config.providers[providerId];
      config = {
        ...config,
        providers: {
          ...config.providers,
          [providerId]: {
            kind: existing?.kind ?? guessKind(providerId),
            ...(existing?.baseUrl === undefined ? {} : { baseUrl: existing.baseUrl }),
            apiKey: ref,
            models: existing?.models ?? [],
          },
        },
      };
    },

    async close(): Promise<void> {
      denyAllPending();
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

/** 没有配置过这一家时的兜底判断。只在"用户刚录入 key"这一步用得到 */
const guessKind = (providerId: string): Config['providers'][string]['kind'] =>
  providerId === 'anthropic' ? 'anthropic' : 'openai-compatible';

/**
 * 没有配好 Provider 时的兜底"模型"。
 *
 * 保留它而不是直接报错，是为了让**没有 key 的人也能把界面跑起来**并看到
 * 该去哪里录入 key。一旦真 Provider 配好，这段代码就再也不会被走到。
 */
function demoProvider(text: string): ScriptedProvider {
  return new ScriptedProvider({
    turns: [
      {
        chunks: [
          {
            kind: 'text_delta',
            text: `还没有配置模型 API key，所以这条是本地回显：${text}`,
          },
          {
            kind: 'usage',
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
          { kind: 'stop', reason: 'end_turn' },
        ],
      },
    ],
  });
}
