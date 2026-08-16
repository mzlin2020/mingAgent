import { useState } from 'react';
import type { ReactNode } from 'react';
import { ALL_CAPABILITIES } from '@xm/contracts';
import type { UpdateSettingsRequest, UserDenyRule } from '../../shared/ipc.js';
import { uniqueDenyRuleId } from '../lib/settings-draft.js';
import { Card, Field, SettingsSaveBar, SettingsSection, TextField } from './settings-kit.js';

export function SettingsPermission({
  draft,
  allowCount,
  redLines,
  onDraft,
  saving,
  dirty,
  onSave,
}: {
  readonly draft: UpdateSettingsRequest;
  readonly allowCount: number;
  readonly redLines: readonly { readonly target: string; readonly capabilities: readonly string[]; readonly why: string }[];
  readonly onDraft: (patch: Partial<UpdateSettingsRequest>) => void;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly onSave: () => void;
}): ReactNode {
  return (
    <div className="space-y-8">
      <SettingsSection
        title="拒绝清单"
        description="只能新增拒绝。允许规则必须写在 config.json 里——设置页提交 allow 会被主进程拒绝。"
      >
        {allowCount > 0 && (
          <p className="mb-3 text-meta text-muted">
            配置文件里还有 {String(allowCount)} 条允许规则，本页不展示、保存时也不会删除。
          </p>
        )}
        <div className="space-y-2">
          {draft.permissionDenies.map((rule, index) => (
            <Card key={`${rule.id}:${String(index)}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{rule.capability}</p>
                  <p className="mt-1 text-meta text-muted">{rule.reason}</p>
                  {rule.match?.target !== undefined && (
                    <code className="mt-1 block truncate text-micro text-faint">{rule.match.target}</code>
                  )}
                </div>
                <button
                  type="button"
                  className="text-micro text-danger hover:underline"
                  onClick={() => {
                    onDraft({ permissionDenies: draft.permissionDenies.filter((_, i) => i !== index) });
                  }}
                >
                  删除
                </button>
              </div>
            </Card>
          ))}
        </div>
        <AddDeny
          existingIds={new Set(draft.permissionDenies.map((rule) => rule.id))}
          onAdd={(rule) => { onDraft({ permissionDenies: [...draft.permissionDenies, rule] }); }}
        />
      </SettingsSection>

      <SettingsSection
        title="红线"
        description="内置核心保护，不能在设置页关闭。同一条路径会同时挂在多个能力上——按目标写，不按调用方自称在做什么写。"
      >
        <ul className="divide-y divide-border rounded-card border border-border">
          {redLines.map((row) => (
            <li key={`${row.target}:${row.why}`} className="px-3 py-2">
              <code className="block truncate text-meta">{row.target}</code>
              <p className="mt-1 text-meta text-muted">{row.why}</p>
              <p className="mt-1 text-micro text-faint">{row.capabilities.join(' · ')}</p>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <SettingsSaveBar dirty={dirty} saving={saving} onSave={onSave} />
    </div>
  );
}

function AddDeny({
  existingIds,
  onAdd,
}: {
  readonly existingIds: ReadonlySet<string>;
  readonly onAdd: (rule: UserDenyRule) => void;
}): ReactNode {
  const [capability, setCapability] = useState<UserDenyRule['capability']>('fs.write');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');

  const submit = (): void => {
    if (reason.trim() === '') return;
    const id = uniqueDenyRuleId(capability, target, existingIds);
    onAdd({
      id,
      effect: 'deny',
      capability,
      reason: reason.trim(),
      ...(target.trim() === '' ? {} : { match: { target: target.trim() } }),
    });
    setReason('');
    setTarget('');
  };

  return (
    <div className="mt-3 grid gap-2 rounded-card border border-border p-3">
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="能力">
          <select
            className="h-9 w-full rounded-control border border-border bg-surface px-2 text-body outline-none focus:border-accent"
            value={capability}
            onChange={(event) => { setCapability(event.target.value as UserDenyRule['capability']); }}
          >
            <option value="*">*</option>
            {ALL_CAPABILITIES.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </Field>
        <Field label="目标 glob（可空）">
          <TextField value={target} onChange={setTarget} placeholder="例如 ~/.ssh/**" />
        </Field>
      </div>
      <Field label="理由">
        <TextField value={reason} onChange={setReason} placeholder="展示给自己看的那句话" />
      </Field>
      <button
        type="button"
        className="h-9 justify-self-start rounded-control bg-accent px-3 text-meta text-on-accent disabled:opacity-45"
        disabled={reason.trim() === ''}
        onClick={submit}
      >
        新增拒绝规则
      </button>
    </div>
  );
}

