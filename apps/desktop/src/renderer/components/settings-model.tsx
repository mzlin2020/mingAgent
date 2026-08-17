import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SettingsResult, UpdateSettingsRequest } from '../../shared/ipc.js';
import { api } from '../bridge.js';
import { cn } from '../lib/cn.js';
import {
  isImplementedProviderKind,
  parsePriceField,
  providerKindOptions,
  uniqueRecordKey,
} from '../lib/settings-draft.js';
import { errorText } from '../lib/settings-request.js';
import { useUi } from '../store.js';
import { Card, Field, SettingsSaveBar, SettingsSection, TextField } from './settings-kit.js';

export function SettingsModel({
  settings,
  draft,
  onDraft,
  saving,
  dirty,
  onSave,
  onReload,
}: {
  readonly settings: SettingsResult;
  readonly draft: UpdateSettingsRequest;
  readonly onDraft: (patch: Partial<UpdateSettingsRequest>) => void;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly onSave: () => void;
  readonly onReload: () => Promise<void>;
}): ReactNode {
  return (
    <div className="space-y-8">
      <SettingsSection
        title="模型角色"
        description="下一回合生效，不必重启应用。写法是 providerId/model，例如 openai/gpt-4。"
      >
        <div className="grid gap-3">
          <Field label="主循环">
            <TextField value={draft.model.main} onChange={(main) => { onDraft({ model: { ...draft.model, main } }); }} />
          </Field>
          <Field label="子 Agent（可空，空则回落主循环）">
            <TextField
              value={draft.model.subagent ?? ''}
              onChange={(value) => {
                onDraft({ model: { ...draft.model, ...(value.trim() === '' ? { subagent: undefined } : { subagent: value }) } });
              }}
            />
          </Field>
          <Field label="摘要（可空，空则回落主循环）">
            <TextField
              value={draft.model.summarize ?? ''}
              onChange={(value) => {
                onDraft({ model: { ...draft.model, ...(value.trim() === '' ? { summarize: undefined } : { summarize: value }) } });
              }}
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Provider"
        description="地址与类型写在配置里。API Key 只进系统钥匙串，不会出现在 config.json。"
      >
        <p className="mb-3 text-micro text-faint">
          密钥后端：{backendLabel(settings.meta.secretBackend)}
        </p>
        <div className="space-y-3">
          {draft.providers.map((provider, index) => (
            <ProviderCard
              key={`${provider.id}:${String(index)}`}
              provider={provider}
              hasApiKey={settings.providers.find((row) => row.id === provider.id)?.hasApiKey === true}
              onChange={(next) => {
                const providers = [...draft.providers];
                providers[index] = next;
                onDraft({ providers });
              }}
              onRemove={() => {
                onDraft({ providers: draft.providers.filter((_, i) => i !== index) });
              }}
              onReload={onReload}
            />
          ))}
        </div>
        <button
          type="button"
          className="mt-3 text-meta text-accent hover:underline"
          onClick={() => {
            onDraft({
              providers: [
                ...draft.providers,
                {
                  id: uniqueRecordKey(draft.providers.map((item) => item.id), 'openai'),
                  kind: 'openai-compatible',
                  models: [],
                },
              ],
            });
          }}
        >
          添加 Provider
        </button>
      </SettingsSection>

      <SettingsSection title="价目表" description="单位：美元 / 百万 token。缺省时花费显示为未知，不会当成 $0。">
        <PriceEditor
          prices={draft.prices}
          onChange={(prices) => { onDraft({ prices }); }}
        />
      </SettingsSection>

      <SettingsSaveBar dirty={dirty} saving={saving} onSave={onSave} />
    </div>
  );
}

function ProviderCard({
  provider,
  hasApiKey,
  onChange,
  onRemove,
  onReload,
}: {
  readonly provider: UpdateSettingsRequest['providers'][number];
  readonly hasApiKey: boolean;
  readonly onChange: (next: UpdateSettingsRequest['providers'][number]) => void;
  readonly onRemove: () => void;
  readonly onReload: () => Promise<void>;
}): ReactNode {
  const refreshStatus = useUi((state) => state.refreshStatus);
  const [key, setKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string>();

  const saveKey = async (): Promise<void> => {
    if (key.trim() === '') return;
    setSavingKey(true);
    setKeyError(undefined);
    try {
      await api.setApiKey(provider.id, key.trim());
      setKey('');
      await refreshStatus();
      await onReload();
    } catch (cause) {
      setKeyError(errorText(cause));
    } finally {
      setSavingKey(false);
    }
  };

  return (
    <Card>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="ID"
          {...(hasApiKey ? { hint: '已配置密钥后不能改 ID。要换名字请先移除再添加。' } : {})}
        >
          <TextField
            value={provider.id}
            disabled={hasApiKey}
            onChange={(id) => { onChange({ ...provider, id }); }}
          />
        </Field>
        <Field
          label="类型"
          {...(isImplementedProviderKind(provider.kind)
            ? {}
            : { hint: '这个类型尚未接入，保存后下一回合会回落到本地回显。' })}
        >
          <select
            className="h-9 w-full rounded-control border border-border bg-surface px-2 text-body outline-none focus:border-accent"
            value={provider.kind}
            onChange={(event) => {
              onChange({ ...provider, kind: event.target.value as UpdateSettingsRequest['providers'][number]['kind'] });
            }}
          >
            {providerKindOptions(provider.kind).map((kind) => (
              <option key={kind} value={kind}>{kind}</option>
            ))}
          </select>
        </Field>
        <Field label="Base URL（可空）" hint="兼容端点才需要填。">
          <TextField
            type="url"
            value={provider.baseUrl ?? ''}
            onChange={(value) => {
              onChange({ ...provider, ...(value.trim() === '' ? { baseUrl: undefined } : { baseUrl: value }) });
            }}
          />
        </Field>
        <Field label="API Key">
          <div className="flex gap-2">
            <TextField
              type="password"
              value={key}
              placeholder={hasApiKey ? '已配置（不回显）' : '尚未配置'}
              onChange={setKey}
            />
            <button
              type="button"
              disabled={savingKey || key.trim() === ''}
              className={cn(
                'h-9 shrink-0 rounded-control bg-accent px-3 text-meta text-on-accent',
                'disabled:opacity-45',
              )}
              onClick={() => { void saveKey(); }}
            >
              {savingKey ? '保存中…' : '保存密钥'}
            </button>
          </div>
          {keyError !== undefined && <p className="mt-1 text-micro text-danger">{keyError}</p>}
        </Field>
      </div>
      <button type="button" className="mt-3 text-micro text-danger hover:underline" onClick={onRemove}>
        移除这个 Provider
      </button>
    </Card>
  );
}

function PriceEditor({
  prices,
  onChange,
}: {
  readonly prices: UpdateSettingsRequest['prices'];
  readonly onChange: (prices: UpdateSettingsRequest['prices']) => void;
}): ReactNode {
  const [texts, setTexts] = useState<Record<string, { input: string; output: string }>>({});
  const rows = Object.entries(prices);

  const fieldText = (id: string, field: 'input' | 'output', fallback: number): string =>
    texts[id]?.[field] ?? String(fallback);

  const writeField = (id: string, field: 'input' | 'output', raw: string, price: UpdateSettingsRequest['prices'][string]): void => {
    setTexts((current) => ({
      ...current,
      [id]: {
        input: field === 'input' ? raw : (current[id]?.input ?? String(price.input)),
        output: field === 'output' ? raw : (current[id]?.output ?? String(price.output)),
      },
    }));
    const parsed = parsePriceField(raw);
    if (parsed !== undefined) onChange({ ...prices, [id]: { ...price, [field]: parsed } });
  };

  return (
    <div className="space-y-2">
      {rows.map(([id, price]) => (
        <div key={id} className="grid grid-cols-[1fr_5rem_5rem_auto] items-center gap-2">
          <TextField
            value={id}
            onChange={(nextId) => {
              const next: UpdateSettingsRequest['prices'] = {};
              for (const [key, value] of Object.entries(prices)) {
                next[key === id ? nextId : key] = value;
              }
              setTexts((current) => {
                const moved = current[id];
                if (moved === undefined) return current;
                const nextTexts: Record<string, { input: string; output: string }> = {};
                for (const [key, value] of Object.entries(current)) {
                  if (key !== id) nextTexts[key] = value;
                }
                nextTexts[nextId] = moved;
                return nextTexts;
              });
              onChange(next);
            }}
          />
          <TextField
            value={fieldText(id, 'input', price.input)}
            onChange={(value) => { writeField(id, 'input', value, price); }}
          />
          <TextField
            value={fieldText(id, 'output', price.output)}
            onChange={(value) => { writeField(id, 'output', value, price); }}
          />
          <button
            type="button"
            className="text-micro text-danger hover:underline"
            onClick={() => {
              const next: UpdateSettingsRequest['prices'] = {};
              for (const [key, value] of Object.entries(prices)) {
                if (key !== id) next[key] = value;
              }
              setTexts((current) => {
                const nextTexts: Record<string, { input: string; output: string }> = {};
                for (const [key, value] of Object.entries(current)) {
                  if (key !== id) nextTexts[key] = value;
                }
                return nextTexts;
              });
              onChange(next);
            }}
          >
            删除
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-meta text-accent hover:underline"
        onClick={() => {
          const key = uniqueRecordKey(Object.keys(prices), 'provider/model');
          onChange({ ...prices, [key]: { input: 0, output: 0 } });
        }}
      >
        添加价目
      </button>
      {rows.length > 0 && <p className="text-micro text-faint">两列数字分别是输入 / 输出单价。</p>}
    </div>
  );
}

function backendLabel(backend: SettingsResult['meta']['secretBackend']): string {
  if (backend === 'keychain') return '系统钥匙串';
  if (backend === 'encrypted-file') return '加密文件';
  return '当前环境存不了密钥';
}
