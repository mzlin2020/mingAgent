import type { ReactNode } from 'react';
import type { SettingsResult, UpdateSettingsRequest } from '../../shared/ipc.js';
import { cn } from '../lib/cn.js';
import { ChoiceCard, SettingsSaveBar, SettingsSection } from './settings-kit.js';

export function SettingsTools({
  settings,
  draft,
  onDraft,
  saving,
  dirty,
  onSave,
}: {
  readonly settings: SettingsResult;
  readonly draft: UpdateSettingsRequest;
  readonly onDraft: (patch: Partial<UpdateSettingsRequest>) => void;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly onSave: () => void;
}): ReactNode {
  const disabled = new Set(draft.disabledTools);
  return (
    <div className="space-y-8">
      <SettingsSection
        title="呈现模式"
        description="决定模型在提示词里看见哪些工具。下一回合生效。"
      >
        <div className="grid gap-2">
          <ChoiceCard
            selected={draft.presentation === 'native'}
            title="native（默认）"
            detail="每个工具一条函数声明，模型逐次调用。"
            onSelect={() => { onDraft({ presentation: 'native' }); }}
          />
          <ChoiceCard
            selected={draft.presentation === 'code'}
            title="code"
            detail="只暴露 run_code 与生成的 SDK。模型直接点名别的工具会得到「未知工具」，不是被拒绝。"
            onSelect={() => { onDraft({ presentation: 'code' }); }}
          />
          <ChoiceCard
            selected={draft.presentation === 'both'}
            title="both"
            detail="两种都给。同一个能力有两条路径，判定仍然只有一份。"
            onSelect={() => { onDraft({ presentation: 'both' }); }}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="工具" description="关闭后，小明不会在后续回合看到或调用该工具。平台不支持的工具无法启用。">
        {settings.tools.length === 0 && (
          <p className="rounded-card border border-border bg-surface p-3 text-meta text-muted">
            当前 profile 未装载任何工具；对话与会话恢复仍可正常使用。
          </p>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          {settings.tools.map((tool) => {
            const enabled = !disabled.has(tool.name);
            return (
              <label
                key={tool.name}
                className={cn('flex gap-3 rounded-card border border-border p-3', !tool.available && 'opacity-55')}
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--color-accent)]"
                  checked={enabled && tool.available}
                  disabled={!tool.available}
                  onChange={(event) => {
                    const next = new Set(disabled);
                    if (event.target.checked) next.delete(tool.name);
                    else next.add(tool.name);
                    onDraft({ disabledTools: [...next] });
                  }}
                />
                <span className="min-w-0">
                  <span className="block font-medium">{tool.name}</span>
                  <span className="mt-0.5 block text-meta text-muted">{tool.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSaveBar dirty={dirty} saving={saving} onSave={onSave} />
    </div>
  );
}
