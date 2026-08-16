import type { Config, ConfigPatch, PolicyRuleSet, ProviderConfig } from '@xm/contracts';
import type { UpdateSettingsRequest } from '../shared/ipc-settings.js';

/**
 * 设置写入的纯函数部分（ADR-0075）。
 *
 * 不碰磁盘、不碰 Electron：主进程先在这里算出下一份配置与补丁，
 * 再决定要不要 persist。闸门都在这里，方便反向演练直接喂对象。
 */

export function settingsFail(code: string, message: string): never {
  const error = new Error(message);
  error.name = code;
  throw error;
}

export function assertSettingsUpdate(update: UpdateSettingsRequest): void {
  if (update.workspace.mode === 'fixed' && update.workspace.defaultPath === undefined) {
    settingsFail('settings.invalid', '固定工作目录模式必须先选择一个目录。');
  }
  const providerIds = update.providers.map((item) => item.id);
  if (new Set(providerIds).size !== providerIds.length) {
    settingsFail('settings.invalid', 'Provider ID 不能重复。');
  }
  for (const rule of update.permissionDenies) {
    // schema 已经是 literal('deny')。留下这条扫描：schema 被改宽时闸门还在（ADR-0075）。
    const effect: string = rule.effect;
    if (effect !== 'deny') {
      settingsFail('settings.allow_rejected', '设置页只能新增拒绝规则。allow 必须写在 config.json 里。');
    }
  }
  if (looksLikeSecretPayload(update)) {
    settingsFail('settings.secret_rejected', 'API Key 只能走独立的密钥通道，不能写进设置请求。');
  }
}

export function nextUserRules(existing: PolicyRuleSet, denies: UpdateSettingsRequest['permissionDenies']): PolicyRuleSet {
  const allows = existing.filter((rule) => rule.effect === 'allow');
  const nextDenies: PolicyRuleSet = denies.map((rule) => ({
    id: rule.id,
    effect: 'deny',
    capability: rule.capability,
    reason: rule.reason,
    immutable: false,
    ...(rule.match === undefined ? {} : { match: rule.match }),
  }));
  return [...allows, ...nextDenies];
}

export function nextProviders(
  existing: Config['providers'],
  updates: UpdateSettingsRequest['providers'],
): Config['providers'] {
  // SecretRef 只按 id 抄。改名等于换槽位——设置页在已有密钥时锁死 ID。
  const next: Record<string, ProviderConfig> = {};
  for (const item of updates) {
    const prev = existing[item.id];
    next[item.id] = {
      kind: item.kind,
      models: item.models,
      ...(item.baseUrl === undefined ? {} : { baseUrl: item.baseUrl }),
      ...(prev?.apiKey === undefined ? {} : { apiKey: prev.apiKey }),
    };
  }
  return next;
}

/**
 * 当前注册表里没有的停用项也要保住。
 * 空工具 profile 下保存任意设置，不能把 `tools-core` 里原先关掉的名字从磁盘抹掉。
 */
export function nextDisabledTools(
  currentDisabled: readonly string[],
  requested: readonly string[],
  knownTools: ReadonlySet<string>,
): string[] {
  const fromUi = [...new Set(requested)].filter((name) => knownTools.has(name));
  const preserved = currentDisabled.filter((name) => !knownTools.has(name));
  return [...new Set([...fromUi, ...preserved])].sort();
}

/** 缺的 baseUrl 必须显式 null，深合并才会删掉磁盘上的旧地址。 */
export function providersPersistRecord(next: Config['providers']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(next)) {
    out[id] = {
      kind: provider.kind,
      models: provider.models,
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
      baseUrl: provider.baseUrl ?? null,
    };
  }
  return out;
}

/** record 深合并删不掉键，缺的 id 必须显式 null。 */
export function recordReplacePatch(
  key: 'providers' | 'prices',
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): ConfigPatch {
  const inner: Record<string, unknown> = {};
  for (const id of Object.keys(existing)) {
    if (!(id in next)) inner[id] = null;
  }
  for (const [id, value] of Object.entries(next)) inner[id] = value;
  return { [key]: inner };
}

export function buildSettingsPatch(
  current: Config,
  update: UpdateSettingsRequest,
  nextProv: Config['providers'],
  userRules: PolicyRuleSet,
  knownTools: ReadonlySet<string>,
): ConfigPatch {
  const disabled = nextDisabledTools(current.tools.disabled, update.disabledTools, knownTools);
  return {
    workspace: update.workspace,
    tools: { disabled, presentation: update.presentation },
    model: {
      main: update.model.main,
      subagent: update.model.subagent ?? null,
      summarize: update.model.summarize ?? null,
    },
    ...recordReplacePatch('providers', current.providers, providersPersistRecord(nextProv)),
    ...recordReplacePatch('prices', current.prices, update.prices),
    permission: { rules: userRules },
  };
}

export function nextConfig(
  current: Config,
  update: UpdateSettingsRequest,
  nextProv: Config['providers'],
  knownTools: ReadonlySet<string>,
): Config {
  const disabled = nextDisabledTools(current.tools.disabled, update.disabledTools, knownTools);
  return {
    ...current,
    workspace: update.workspace,
    tools: { disabled, presentation: update.presentation },
    model: {
      main: update.model.main,
      ...(update.model.subagent === undefined ? {} : { subagent: update.model.subagent }),
      ...(update.model.summarize === undefined ? {} : { summarize: update.model.summarize }),
    },
    providers: nextProv,
    prices: update.prices,
    permission: { rules: [] },
  };
}

function looksLikeSecretPayload(value: unknown): boolean {
  if (typeof value === 'string') return false;
  if (Array.isArray(value)) return value.some(looksLikeSecretPayload);
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(apiKey|api_key|key|token|password|secret)$/i.test(key) && typeof nested === 'string') {
      return true;
    }
    if (looksLikeSecretPayload(nested)) return true;
  }
  return false;
}
