import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { SettingsResult, UpdateSettingsRequest } from '../../shared/ipc.js';
import { api } from '../bridge.js';
import { cn } from '../lib/cn.js';
import { errorText, toUpdateRequest } from '../lib/settings-request.js';
import { useUi } from '../store.js';
import { SettingsAbout, SettingsStorage } from './settings-storage.js';
import { SettingsGeneral } from './settings-general.js';
import { SettingsModel } from './settings-model.js';
import { SettingsPermission } from './settings-permission.js';
import { SettingsTools } from './settings-tools.js';
import { SettingsNotice } from './settings-kit.js';

const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'model', label: '模型与 Provider' },
  { id: 'tools', label: '工具与呈现' },
  { id: 'permission', label: '权限' },
  { id: 'storage', label: '数据与存储' },
  { id: 'about', label: '关于与安全边界' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function SettingsModal(): ReactNode {
  const closeSettings = useUi((state) => state.closeSettings);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const [section, setSection] = useState<SectionId>('general');
  const [settings, setSettings] = useState<SettingsResult>();
  const [draft, setDraft] = useState<UpdateSettingsRequest>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    openerRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void api.settings().then(
      (result) => {
        if (!active) return;
        setSettings(result);
        setDraft(toUpdateRequest(result));
      },
      (cause: unknown) => {
        if (active) setError(errorText(cause));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const dirty = useMemo(() => {
    if (settings === undefined || draft === undefined) return false;
    return JSON.stringify(draft) !== JSON.stringify(toUpdateRequest(settings));
  }, [draft, settings]);

  const apply = (next: SettingsResult): void => {
    setSettings(next);
    setDraft(toUpdateRequest(next));
  };

  const save = async (): Promise<void> => {
    if (draft === undefined) return;
    if (draft.workspace.mode === 'fixed' && draft.workspace.defaultPath === undefined) {
      setError('固定目录模式需要先选择一个目录。');
      return;
    }
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const payload: UpdateSettingsRequest = {
        ...draft,
        model: {
          main: draft.model.main,
          ...(draft.model.subagent !== undefined && draft.model.subagent.trim() !== ''
            ? { subagent: draft.model.subagent.trim() }
            : {}),
          ...(draft.model.summarize !== undefined && draft.model.summarize.trim() !== ''
            ? { summarize: draft.model.summarize.trim() }
            : {}),
        },
      };
      apply(await api.updateSettings(payload));
      setMessage('设置已保存。模型、呈现模式、权限与工具在下一回合生效；工作目录只影响之后新建的任务。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeSettings();
    }
  };

  const onDraft = (patch: Partial<UpdateSettingsRequest>): void => {
    setDraft((current) => (current === undefined ? current : { ...current, ...patch }));
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label="关闭设置"
        className="absolute inset-0 bg-fg/25"
        onClick={closeSettings}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative flex h-[min(720px,calc(100vh-48px))] w-[min(880px,calc(100vw-48px))] overflow-hidden rounded-card border border-border bg-surface shadow-pop"
      >
        <nav className="flex w-44 shrink-0 flex-col border-r border-border bg-canvas py-3">
          <p id="settings-title" className="px-3 pb-2 text-meta font-semibold text-muted">设置</p>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                'px-3 py-1.5 text-left text-meta',
                section === item.id ? 'bg-accent-weak text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
              )}
              onClick={() => { setSection(item.id); }}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-end border-b border-border px-3 py-2">
            <button
              ref={closeRef}
              type="button"
              className="h-8 w-8 rounded-control text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="关闭"
              onClick={closeSettings}
            >
              ×
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {error !== undefined && <div className="mb-4"><SettingsNotice tone="danger">{error}</SettingsNotice></div>}
            {message !== undefined && <div className="mb-4"><SettingsNotice>{message}</SettingsNotice></div>}
            {settings === undefined || draft === undefined ? (
              <p className="text-body text-muted">正在读取设置…</p>
            ) : (
              <SectionBody
                section={section}
                settings={settings}
                draft={draft}
                onDraft={onDraft}
                saving={saving}
                dirty={dirty}
                onSave={() => { void save(); }}
                onApplied={apply}
                onReload={async () => {
                  // 只刷新快照（hasApiKey 等）。保存密钥不能把未保存的价目 / 模型改动扔掉。
                  setSettings(await api.settings());
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionBody({
  section,
  settings,
  draft,
  onDraft,
  saving,
  dirty,
  onSave,
  onApplied,
  onReload,
}: {
  readonly section: SectionId;
  readonly settings: SettingsResult;
  readonly draft: UpdateSettingsRequest;
  readonly onDraft: (patch: Partial<UpdateSettingsRequest>) => void;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly onSave: () => void;
  readonly onApplied: (next: SettingsResult) => void;
  readonly onReload: () => Promise<void>;
}): ReactNode {
  switch (section) {
    case 'general':
      return <SettingsGeneral draft={draft} onDraft={onDraft} saving={saving} dirty={dirty} onSave={onSave} />;
    case 'model':
      return (
        <SettingsModel
          settings={settings}
          draft={draft}
          onDraft={onDraft}
          saving={saving}
          dirty={dirty}
          onSave={onSave}
          onReload={onReload}
        />
      );
    case 'tools':
      return <SettingsTools settings={settings} draft={draft} onDraft={onDraft} saving={saving} dirty={dirty} onSave={onSave} />;
    case 'permission':
      return (
        <SettingsPermission
          draft={draft}
          allowCount={settings.meta.userAllowRuleCount}
          redLines={settings.redLines}
          onDraft={onDraft}
          saving={saving}
          dirty={dirty}
          onSave={onSave}
        />
      );
    case 'storage':
      return <SettingsStorage settings={settings} onApplied={onApplied} />;
    case 'about':
      return <SettingsAbout settings={settings} />;
  }
}
