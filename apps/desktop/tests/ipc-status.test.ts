import { describe, expect, it, vi } from 'vitest';
import { newCallId, newSessionId } from '@xm/contracts';
import { IpcEnvelope, SettingsResult, StatusResult } from '../src/shared/ipc.js';
import { CH } from '../src/shared/channels.js';
import type { RuntimeStatus, Services } from '../src/main/desktop-host.js';

type IpcHandler = (event: unknown, raw: unknown) => Promise<unknown>;
const mockedElectron = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>() }));

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mockedElectron.handlers.set(channel, handler);
    }),
  },
}));

const { registerIpc } = await import('../src/main/ipc.js');

describe('desktop status IPC', () => {
  it('returns the complete StatusResult including the structured security field', async () => {
    const security: RuntimeStatus['security'] = {
      boundary: 'host-autonomous-protected-core',
      osSandbox: false,
      protectedResources: ['运行数据'],
      enabledTools: ['fs.read'],
      disabledTools: ['fs.delete'],
      unavailableTools: ['shell.session.run'],
      terminalMode: 'controlled-argv-no-stdin',
      logRedaction: true,
    };
    const status: RuntimeStatus = {
      providerReady: true,
      providerId: 'openai',
      model: 'test-model',
      secretBackend: 'keychain',
      hasApiKey: true,
      configProblems: [],
      security,
    };
    const services = {
      status: vi.fn(() => Promise.resolve(status)),
      bus: { subscribe: vi.fn() },
    } as unknown as Services;

    registerIpc(services, () => []);
    const handler = mockedElectron.handlers.get(CH.status);
    expect(handler).toBeDefined();
    const envelope = IpcEnvelope.parse(await handler?.({}, undefined));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(StatusResult.parse(envelope.data).security).toEqual(security);
  });
});

describe('settings IPC', () => {
  const settings = {
    workspace: { mode: 'choose' as const },
    presentation: 'native' as const,
    tools: [{ name: 'fs.read', description: 'read', enabled: true, available: true }],
    model: { main: 'openai/gpt' },
    providers: [],
    prices: {},
    permissionDenies: [],
    redLines: [{ target: '/', capabilities: ['fs.delete'], why: '根目录' }],
    storage: {
      dataDirectory: 'C:/data',
      configDirectory: 'C:/config',
      cacheDirectory: 'C:/cache',
      logsDirectory: 'C:/logs',
      items: [{ id: 'search-index' as const, bytes: 12, clearable: true }],
      index: { roots: [] },
    },
    meta: {
      version: '0.0.0',
      secretBackend: 'keychain' as const,
      configProblems: [],
      userAllowRuleCount: 0,
    },
  };
  const validUpdate = {
    workspace: { mode: 'home' as const },
    disabledTools: ['shell.exec'],
    presentation: 'native' as const,
    model: { main: 'openai/gpt' },
    providers: [],
    prices: {},
    permissionDenies: [],
  };

  it('returns settings and validates updates before passing them to services', async () => {
    const updateSettings = vi.fn(() => Promise.resolve(settings));
    const services = {
      settings: vi.fn(() => Promise.resolve(settings)),
      updateSettings,
      bus: { subscribe: vi.fn() },
    } as unknown as Services;
    registerIpc(services, () => []);

    const readEnvelope = IpcEnvelope.parse(
      await mockedElectron.handlers.get(CH.settings)?.({}, undefined),
    );
    expect(readEnvelope.ok).toBe(true);
    if (readEnvelope.ok) expect(SettingsResult.parse(readEnvelope.data)).toEqual(settings);

    const updateEnvelope = IpcEnvelope.parse(
      await mockedElectron.handlers.get(CH.updateSettings)?.({}, validUpdate),
    );
    expect(updateEnvelope.ok).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith(validUpdate);
  });

  it('🔴 提交 allow 规则被主进程拒绝，services 不会被叫到', async () => {
    const updateSettings = vi.fn(() => Promise.resolve(settings));
    registerIpc({ updateSettings, bus: { subscribe: vi.fn() } } as unknown as Services, () => []);
    const envelope = IpcEnvelope.parse(
      await mockedElectron.handlers.get(CH.updateSettings)?.({}, {
        ...validUpdate,
        permissionDenies: [{
          id: 'sneak.allow',
          effect: 'allow',
          capability: 'fs.write',
          reason: '放行',
        }],
      }),
    );
    expect(envelope).toMatchObject({
      ok: false,
      code: 'invalid_input',
      message: 'IPC 入参不合法：Invalid input: expected "deny"',
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('🔴 把 API key 塞进 UpdateSettingsRequest 被主进程拒绝', async () => {
    const updateSettings = vi.fn(() => Promise.resolve(settings));
    registerIpc({ updateSettings, bus: { subscribe: vi.fn() } } as unknown as Services, () => []);
    const envelope = IpcEnvelope.parse(
      await mockedElectron.handlers.get(CH.updateSettings)?.({}, {
        ...validUpdate,
        apiKey: 'sk-secret',
      }),
    );
    expect(envelope).toMatchObject({
      ok: false,
      code: 'invalid_input',
      message: 'IPC 入参不合法：Unrecognized key: "apiKey"',
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('🔴 嵌套 apiKey 同样拒绝', async () => {
    const updateSettings = vi.fn(() => Promise.resolve(settings));
    registerIpc({ updateSettings, bus: { subscribe: vi.fn() } } as unknown as Services, () => []);
    const envelope = IpcEnvelope.parse(
      await mockedElectron.handlers.get(CH.updateSettings)?.({}, {
        ...validUpdate,
        providers: [{ id: 'openai', kind: 'openai-compatible', models: [], apiKey: 'sk-secret' }],
      }),
    );
    expect(envelope).toMatchObject({
      ok: false,
      code: 'invalid_input',
      message: 'IPC 入参不合法：Unrecognized key: "apiKey"',
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('🔴 workspace.mode 不合法时两侧都拒绝且有可读错误', async () => {
    const updateSettings = vi.fn(() => Promise.resolve(settings));
    registerIpc({ updateSettings, bus: { subscribe: vi.fn() } } as unknown as Services, () => []);
    const envelope = IpcEnvelope.parse(
      await mockedElectron.handlers.get(CH.updateSettings)?.({}, {
        ...validUpdate,
        workspace: { mode: 'nope' },
      }),
    );
    expect(envelope).toMatchObject({
      ok: false,
      code: 'invalid_input',
      message: 'IPC 入参不合法：Invalid option: expected one of "choose"|"fixed"|"home"',
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe('卡片动作 IPC handler（ADR-0065）', () => {
  it('校验窄入参并把 callId/actionId/载荷原样交给 services', async () => {
    const cardAction = vi.fn(() => Promise.resolve({ dispatched: true }));
    const services = {
      cardAction,
      bus: { subscribe: vi.fn() },
    } as unknown as Services;
    registerIpc(services, () => []);
    const handler = mockedElectron.handlers.get(CH.cardAction);
    const request = {
      sessionId: newSessionId(),
      callId: newCallId(),
      actionId: 'accept',
      payload: { selected: ['0:0'] },
    };
    const envelope = IpcEnvelope.parse(await handler?.({}, request));
    expect(envelope).toMatchObject({ ok: true, data: { dispatched: true } });
    expect(cardAction).toHaveBeenCalledWith(request.sessionId, {
      callId: request.callId,
      actionId: request.actionId,
      payload: request.payload,
    });
  });

  it('🔴 载荷里夹带工具名 / 路径一律拒绝——渲染层说不了"要执行什么"', async () => {
    const cardAction = vi.fn(() => Promise.resolve({ dispatched: true }));
    registerIpc({ cardAction, bus: { subscribe: vi.fn() } } as unknown as Services, () => []);
    const handler = mockedElectron.handlers.get(CH.cardAction);
    const envelope = IpcEnvelope.parse(
      await handler?.({}, {
        sessionId: newSessionId(),
        callId: newCallId(),
        actionId: 'accept',
        payload: { selected: ['0:0'], tool: 'shell.exec' },
      }),
    );
    expect(envelope).toMatchObject({ ok: false });
    expect(cardAction).not.toHaveBeenCalled();
  });
});
