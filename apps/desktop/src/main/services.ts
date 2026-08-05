import { app, safeStorage } from 'electron';
import type { PolicyRuleSet, SessionId } from '@xm/contracts';
import { newSessionId } from '@xm/contracts';
import type { PlatformPort, SecretBackend } from '@xm/kernel';
import { ToolRegistry, builtinRules, policyEnvFromPaths } from '@xm/kernel';
import { nodePlatform, withCapabilities } from '@xm/platform';
import type { OpenedStores } from '@xm/storage';
import { openStores } from '@xm/storage';
import {
  EventBus,
  ScriptedProvider,
  SessionRuntime,
  demoTargetOf,
  echoTool,
  fakeDeleteTool,
  runTurn,
} from '@xm/runtime';

/**
 * 主进程的装配。
 *
 * 这个文件是整个应用**唯一**知道"Electron"与"业务"同时存在的地方——
 * 再往下的每一层都不认识 electron（depcruise 强制），再往上的渲染层没有 Node 权限。
 */
export interface Services {
  readonly platform: PlatformPort;
  readonly stores: OpenedStores;
  readonly bus: EventBus;
  readonly rules: PolicyRuleSet;
  readonly tools: ToolRegistry;
  createSession(title?: string): Promise<SessionId>;
  sendUserMessage(sessionId: SessionId, text: string): Promise<string>;
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
  const secrets: SecretBackend = safeStorage.isEncryptionAvailable()
    ? 'keychain'
    : 'encrypted-file';

  const platform = withCapabilities(base, {
    secrets,
    tray: true,
    notifications: true,
  });

  const paths = platform.paths();
  const stores = await openStores(paths);
  const rules = builtinRules(policyEnvFromPaths(paths));
  const bus = new EventBus();

  const tools = new ToolRegistry();
  tools.register(echoTool());
  tools.register(fakeDeleteTool());

  const runtimes = new Map<SessionId, SessionRuntime>();

  const runtimeFor = async (sessionId: SessionId): Promise<SessionRuntime> => {
    const existing = runtimes.get(sessionId);
    if (existing !== undefined) return existing;
    // 同一会话只允许一个写者（不变量四）：句柄的生命周期就是租约，缓存住它
    const created = await SessionRuntime.open({ sessionId, store: stores.events, bus });
    runtimes.set(sessionId, created);
    return created;
  };

  return {
    platform,
    stores,
    bus,
    rules,
    tools,

    async createSession(title?: string): Promise<SessionId> {
      const sessionId = newSessionId();
      const runtime = await runtimeFor(sessionId);
      await runtime.record({
        type: 'session.created',
        payload: {
          cwd: app.getPath('home'),
          modelRef: 'scripted/scripted-1',
          ...(title === undefined ? {} : { title }),
        },
      });
      return sessionId;
    },

    /**
     * M0-b 里发出去的是**脚本化**的一轮。真实 Provider 是 M1。
     *
     * 之所以现在就走完整的 `runTurn`，是为了让外壳与装配层的接缝在本轮就被真实检验：
     * M1 换掉的只是 Provider 这一个参数，而不是重新想一遍事件怎么流到 UI。
     */
    async sendUserMessage(sessionId: SessionId, text: string): Promise<string> {
      const runtime = await runtimeFor(sessionId);
      const provider = demoProvider(text);
      return runTurn(
        {
          runtime,
          provider,
          tools,
          rules,
          tier: 'balanced',
          model: 'scripted-1',
          targetOf: demoTargetOf,
          pathCaseInsensitive: platform.os === 'windows',
          // 审批 UI 是 M1。在那之前 ask 一律拒绝——默认放行等于没有闸门
          decide: () => Promise.resolve('deny'),
        },
        text,
      );
    },

    async close(): Promise<void> {
      for (const runtime of runtimes.values()) await runtime.close();
      runtimes.clear();
      await stores.close();
    },
  };
}

/** 空壳期的"模型"：把用户输入回显一遍，好让事件流在 UI 上看得见 */
function demoProvider(text: string): ScriptedProvider {
  return new ScriptedProvider({
    turns: [
      {
        chunks: [
          { kind: 'thinking_delta', text: '（这是空壳期的脚本化回复）' },
          { kind: 'text_delta', text: `收到：${text}` },
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
