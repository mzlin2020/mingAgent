import { describe, expect, it, vi } from 'vitest';
import { newEditProposalId, newSessionId } from '@xm/contracts';
import { IpcEnvelope, SettingsResult, StatusResult } from '../src/shared/ipc.js';
import { CH } from '../src/shared/channels.js';
import type { RuntimeStatus, Services } from '../src/main/services.js';

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
  it('returns settings and validates updates before passing them to services', async () => {
    const settings = {
      workspace: { mode: 'choose' as const },
      tools: [{ name: 'fs.read', description: 'read', enabled: true, available: true }],
      storage: {
        dataDirectory: 'C:/data',
        configDirectory: 'C:/config',
        cacheDirectory: 'C:/cache',
        logsDirectory: 'C:/logs',
        items: [{ id: 'search-index' as const, bytes: 12, clearable: true }],
        index: { roots: [] },
      },
    };
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

    const request = { workspace: { mode: 'home' }, disabledTools: ['shell.exec'] };
    const updateEnvelope = IpcEnvelope.parse(
      await mockedElectron.handlers.get(CH.updateSettings)?.({}, request),
    );
    expect(updateEnvelope.ok).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith(request);
  });
});

describe('diff review IPC handler', () => {
  it('校验窄入参并把选择原样交给 services', async () => {
    const reviewEditProposal = vi.fn(() => Promise.resolve({ applied: true }));
    const services = {
      reviewEditProposal,
      bus: { subscribe: vi.fn() },
    } as unknown as Services;
    registerIpc(services, () => []);
    const handler = mockedElectron.handlers.get(CH.reviewEditProposal);
    const request = {
      sessionId: newSessionId(),
      proposalId: newEditProposalId(),
      selectedHunkIds: ['0:0'],
    };
    const envelope = IpcEnvelope.parse(await handler?.({}, request));
    expect(envelope).toMatchObject({ ok: true, data: { applied: true } });
    expect(reviewEditProposal).toHaveBeenCalledWith(
      request.sessionId,
      request.proposalId,
      request.selectedHunkIds,
    );
  });
});
