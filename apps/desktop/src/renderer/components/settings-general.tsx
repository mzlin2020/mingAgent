import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { UpdateSettingsRequest } from '../../shared/ipc.js';
import { api } from '../bridge.js';
import {
  applyThemePref,
  readEnterToSend,
  readThemePref,
  subscribeUiPrefs,
  writeEnterToSend,
  writeThemePref,
  type ThemePref,
} from '../lib/ui-prefs.js';
import { ChoiceCard, SettingsSection, SettingsSaveBar } from './settings-kit.js';

export function SettingsGeneral({
  draft,
  onDraft,
  saving,
  dirty,
  onSave,
}: {
  readonly draft: UpdateSettingsRequest;
  readonly onDraft: (patch: Partial<UpdateSettingsRequest>) => void;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly onSave: () => void;
}): ReactNode {
  const theme = useSyncExternalStore(subscribeUiPrefs, () => readThemePref(window.localStorage));
  const enterToSend = useSyncExternalStore(subscribeUiPrefs, () => readEnterToSend(window.localStorage));
  const setTheme = (pref: ThemePref): void => {
    writeThemePref(window.localStorage, pref);
    applyThemePref(pref, document.documentElement);
  };

  return (
    <div className="space-y-8">
      <SettingsSection title="外观" description="只影响这台机器上的窗口，不进配置文件，也不进模型请求。">
        <div className="grid gap-2 md:grid-cols-3">
          <ChoiceCard selected={theme === 'system'} title="跟随系统" detail="跟操作系统的浅色 / 深色走。" onSelect={() => { setTheme('system'); }} />
          <ChoiceCard selected={theme === 'light'} title="浅色" detail="系统是深色时也可以强制浅色。" onSelect={() => { setTheme('light'); }} />
          <ChoiceCard selected={theme === 'dark'} title="深色" detail="系统是浅色时也可以强制深色。" onSelect={() => { setTheme('dark'); }} />
        </div>
      </SettingsSection>

      <SettingsSection title="输入" description="Enter 换行还是发送。同样只存在这台机器上。">
        <div className="grid gap-2 md:grid-cols-2">
          <ChoiceCard
            selected={enterToSend}
            title="Enter 发送"
            detail="Shift+Enter 换行。"
            onSelect={() => { writeEnterToSend(window.localStorage, true); }}
          />
          <ChoiceCard
            selected={!enterToSend}
            title="Enter 换行"
            detail="Ctrl/Cmd+Enter 发送。"
            onSelect={() => { writeEnterToSend(window.localStorage, false); }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="新任务工作目录"
        description="只影响之后新建的任务。已经打开的会话工作目录不变。"
      >
        <div className="grid gap-2 md:grid-cols-3">
          <ChoiceCard
            selected={draft.workspace.mode === 'choose'}
            title="每次选择"
            detail="推荐。新任务开始前选择一个具体项目目录。"
            onSelect={() => { onDraft({ workspace: { mode: 'choose', defaultPath: draft.workspace.defaultPath } }); }}
          />
          <ChoiceCard
            selected={draft.workspace.mode === 'fixed'}
            title="固定目录"
            detail="所有未指定目录的新任务使用同一个目录。"
            onSelect={() => { onDraft({ workspace: { mode: 'fixed', defaultPath: draft.workspace.defaultPath } }); }}
          />
          <ChoiceCard
            selected={draft.workspace.mode === 'home'}
            title="用户目录"
            detail="会扫描较大范围，不推荐作为日常默认值。"
            warning
            onSelect={() => { onDraft({ workspace: { mode: 'home', defaultPath: draft.workspace.defaultPath } }); }}
          />
        </div>
        {draft.workspace.mode === 'fixed' && (
          <div className="mt-3 flex items-center gap-2 rounded-card border border-border bg-surface-2 p-3">
            <code className="min-w-0 flex-1 truncate text-meta text-muted">
              {draft.workspace.defaultPath ?? '尚未选择目录'}
            </code>
            <button
              type="button"
              className="h-7 rounded-control border border-border bg-surface px-2.5 text-meta hover:border-border-strong"
              onClick={() => { void pickDirectory(draft, onDraft); }}
            >
              选择目录
            </button>
          </div>
        )}
        <div className="mt-3">
          <SettingsSaveBar dirty={dirty} saving={saving} onSave={onSave} />
        </div>
      </SettingsSection>
    </div>
  );
}

async function pickDirectory(
  draft: UpdateSettingsRequest,
  onDraft: (patch: Partial<UpdateSettingsRequest>) => void,
): Promise<void> {
  const picked = (await api.chooseWorkspace()).path;
  if (picked !== undefined) {
    onDraft({ workspace: { mode: 'fixed', defaultPath: picked } });
  }
}
