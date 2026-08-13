import type { BlobStore, ModelProvider, SecretStore } from '@xm/kernel';
import type { Config } from '@xm/contracts';
import { parseModelRef } from '@xm/platform';
import { AnthropicProvider, OpenAICompatibleProvider } from '@xm/providers';
import type { ProviderStreamStatus } from '@xm/providers';
import { ScriptedProvider } from '@xm/runtime';

export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

export function configuredModelRef(config: Config, role: 'main' | 'summarize' | 'subagent'): ModelRef {
  const configured =
    role === 'summarize'
      ? config.model.summarize
      : role === 'subagent'
        ? config.model.subagent
        : undefined;
  return parseModelRef(configured ?? config.model.main);
}

export async function openConfiguredProvider(input: {
  readonly ref: ModelRef;
  readonly config: Config;
  readonly secrets: SecretStore;
  readonly blobs: BlobStore;
  readonly onStatus?: (status: ProviderStreamStatus) => void | Promise<void>;
}): Promise<ModelProvider | undefined> {
  const { provider: providerId } = input.ref;
  const cfg = input.config.providers[providerId];
  if (cfg?.apiKey === undefined) return undefined;

  const apiKey = await input.secrets.get(cfg.apiKey);
  if (apiKey === undefined || apiKey === '') return undefined;
  const common = {
    apiKey,
    ...(cfg.baseUrl === undefined ? {} : { baseUrl: cfg.baseUrl }),
    ...(cfg.models.length > 0 ? { models: cfg.models } : {}),
    blobs: input.blobs,
    ...(input.onStatus === undefined ? {} : { onStatus: input.onStatus }),
  };

  switch (cfg.kind) {
    case 'anthropic':
      return new AnthropicProvider(common);
    case 'openai':
    case 'openai-compatible':
      return new OpenAICompatibleProvider({ ...common, id: providerId });
    default:
      return undefined;
  }
}

export const guessProviderKind = (providerId: string): Config['providers'][string]['kind'] =>
  providerId === 'anthropic' ? 'anthropic' : 'openai-compatible';

/** Local onboarding fallback; it is a provider, not a model-visible production tool. */
export function onboardingProvider(text: string): ScriptedProvider {
  return new ScriptedProvider({
    turns: [
      {
        chunks: [
          { kind: 'text_delta', text: `还没有配置模型 API key，所以这条是本地回显：${text}` },
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
