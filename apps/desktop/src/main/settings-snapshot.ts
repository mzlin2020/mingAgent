import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { Config, PolicyRuleSet } from '@xm/contracts';
import type { ExecutionWorld, PlatformPort, SecretStore, ToolRegistry } from '@xm/kernel';
import { projectRedLines, redLineRules, type PolicyEnv } from '@xm/kernel';
import type { OpenedStores } from '@xm/storage';
import type { SettingsResult, UserDenyRule } from '../shared/ipc-settings.js';
import type { SecretBackend } from '@xm/kernel';

export async function readSettingsSnapshot(input: {
  readonly config: Config;
  readonly userRules: PolicyRuleSet;
  readonly tools: ToolRegistry;
  readonly stores: OpenedStores;
  readonly platform: PlatformPort;
  readonly executor: ExecutionWorld;
  readonly secrets: SecretStore;
  readonly policyEnv: PolicyEnv;
  readonly secretBackend: SecretBackend;
  readonly version: string;
  readonly configProblems: readonly { readonly code: string; readonly message: string }[];
}): Promise<SettingsResult> {
  const { config, tools, stores, platform, executor } = input;
  const paths = platform.paths();
  const availability = {
    cwd: paths.home,
    executor,
    platform: platform.capabilities(),
  };
  const available = new Set(tools.descriptors({ ...availability, disabledTools: [] }).map((tool) => tool.name));
  const disabled = new Set(config.tools.disabled);
  const indexDb = join(stores.layout.dataDir, 'workspace-index.sqlite');
  const [indexBytes, sessionBytes, recoveryBytes, logBytes, configBytes] = await Promise.all([
    sizeOfSqlite(indexDb),
    sizeOfSqlite(stores.layout.eventsDb),
    sizeOfPath(stores.layout.blobsDir),
    sizeOfPath(paths.logs),
    sizeOfPath(paths.config),
  ]);

  const providers = await Promise.all(
    Object.entries(config.providers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([id, provider]) => ({
        id,
        kind: provider.kind,
        models: provider.models,
        hasApiKey:
          provider.apiKey === undefined
            ? false
            : await input.secrets.get(provider.apiKey).then((value) => value !== undefined && value !== ''),
        ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
      })),
  );

  const permissionDenies: UserDenyRule[] = input.userRules
    .filter((rule) => rule.effect === 'deny')
    .map((rule) => ({
      id: rule.id,
      effect: 'deny' as const,
      capability: rule.capability,
      reason: rule.reason,
      ...(rule.match === undefined ? {} : { match: rule.match }),
    }));

  return {
    workspace: config.workspace,
    presentation: config.tools.presentation,
    tools: tools.descriptors().map((tool) => ({
      name: tool.name,
      description: tool.description,
      enabled: !disabled.has(tool.name),
      available: available.has(tool.name),
    })),
    model: config.model,
    providers,
    prices: config.prices,
    permissionDenies,
    redLines: projectRedLines(redLineRules(input.policyEnv)).map((line) => ({
      target: line.target,
      capabilities: [...line.capabilities],
      why: line.why,
    })),
    storage: {
      dataDirectory: paths.data,
      configDirectory: paths.config,
      cacheDirectory: paths.cache,
      logsDirectory: paths.logs,
      items: [
        { id: 'search-index', bytes: indexBytes, clearable: true },
        { id: 'sessions', bytes: sessionBytes, clearable: false },
        { id: 'recovery', bytes: recoveryBytes, clearable: false },
        { id: 'logs', bytes: logBytes, clearable: false },
        { id: 'config', bytes: configBytes, clearable: false },
      ],
      index: { roots: stores.index.stats().roots.map((root) => ({ ...root })) },
    },
    meta: {
      version: input.version,
      secretBackend: input.secretBackend,
      configProblems: [...input.configProblems],
      userAllowRuleCount: input.userRules.filter((rule) => rule.effect === 'allow').length,
    },
  };
}

const sizeOfSqlite = async (path: string): Promise<number> =>
  (await Promise.all([path, `${path}-wal`, `${path}-shm`].map(sizeOfPath))).reduce((a, b) => a + b, 0);

async function sizeOfPath(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    const children = await readdir(path, { withFileTypes: true });
    const sizes = await Promise.all(
      children
        .filter((child) => !child.isSymbolicLink())
        .map((child) => sizeOfPath(join(path, child.name))),
    );
    return sizes.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}
