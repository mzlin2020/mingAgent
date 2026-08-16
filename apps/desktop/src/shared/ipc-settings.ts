import { z } from 'zod';
import { Capability, ModelPrice, PriceTable, TrustLevel } from '@xm/contracts';

/**
 * 设置中心 IPC 契约（ADR-0075）。从 `ipc.ts` 拆出，规模纪律；消费方仍只从 `shared/ipc.js` 导入。
 *
 * `UpdateSettingsRequest` 是 strictObject：多一个 `apiKey` / `key` / `effect:'allow'`
 * 在这一层就拒绝。渲染层不信任，主进程不靠「设置页没画这个按钮」。
 */

const WorkspaceSettings = z.strictObject({
  mode: z.enum(['choose', 'fixed', 'home']),
  defaultPath: z.string().max(4096).optional(),
});

export const UserDenyRule = z.strictObject({
  id: z.string().min(1).max(80),
  effect: z.literal('deny'),
  capability: z.union([Capability, z.literal('*')]),
  match: z
    .strictObject({
      target: z.string().min(1).max(4096).optional(),
      executor: z.enum(['local', 'container', 'remote']).optional(),
      trustLevel: z.array(TrustLevel).max(3).optional(),
      ipRange: z.enum(['private']).optional(),
    })
    .optional(),
  reason: z.string().min(1).max(500),
});
export type UserDenyRule = z.infer<typeof UserDenyRule>;

const ProviderKind = z.enum(['anthropic', 'openai', 'openai-compatible', 'google', 'ollama']);

export const ProviderPublic = z.object({
  id: z.string().min(1).max(64),
  kind: ProviderKind,
  baseUrl: z.string().max(4096).optional(),
  models: z.array(z.string()).max(200),
  hasApiKey: z.boolean(),
});

export const ProviderSettingsUpdate = z.strictObject({
  id: z.string().min(1).max(64),
  kind: ProviderKind,
  baseUrl: z.string().max(4096).optional(),
  models: z.array(z.string()).max(200),
});

export const RedLineViewIpc = z.object({
  target: z.string(),
  capabilities: z.array(z.string()),
  why: z.string(),
});

export const SettingsResult = z.object({
  workspace: WorkspaceSettings,
  presentation: z.enum(['native', 'code', 'both']),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    available: z.boolean(),
  })),
  model: z.object({
    main: z.string(),
    subagent: z.string().optional(),
    summarize: z.string().optional(),
  }),
  providers: z.array(ProviderPublic),
  prices: PriceTable,
  permissionDenies: z.array(UserDenyRule),
  redLines: z.array(RedLineViewIpc),
  storage: z.object({
    dataDirectory: z.string(),
    configDirectory: z.string(),
    cacheDirectory: z.string(),
    logsDirectory: z.string(),
    items: z.array(z.object({
      id: z.enum(['search-index', 'sessions', 'recovery', 'logs', 'config']),
      bytes: z.number().int().nonnegative(),
      clearable: z.boolean(),
    })),
    index: z.object({
      roots: z.array(z.object({
        root: z.string(),
        state: z.enum(['cold', 'building', 'ready', 'stale', 'failed']),
        fileCount: z.number().int().nonnegative(),
        sourceBytes: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
      })),
    }),
  }),
  meta: z.object({
    version: z.string(),
    secretBackend: z.enum(['keychain', 'encrypted-file', 'plaintext-unavailable']),
    configProblems: z.array(z.object({ code: z.string(), message: z.string() })),
    userAllowRuleCount: z.number().int().nonnegative(),
  }),
});
export type SettingsResult = z.infer<typeof SettingsResult>;

export const UpdateSettingsRequest = z.strictObject({
  workspace: WorkspaceSettings,
  disabledTools: z.array(z.string()).max(200),
  presentation: z.enum(['native', 'code', 'both']),
  model: z.strictObject({
    main: z.string().min(1).max(200),
    subagent: z.string().min(1).max(200).optional(),
    summarize: z.string().min(1).max(200).optional(),
  }),
  providers: z.array(ProviderSettingsUpdate).max(50),
  prices: z.record(z.string(), ModelPrice),
  permissionDenies: z.array(UserDenyRule).max(200),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;
