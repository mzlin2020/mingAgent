import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SettingsResult } from '../../shared/ipc.js';
import { api } from '../bridge.js';
import { cn } from '../lib/cn.js';
import { COLUMN } from '../lib/layout.js';
import { useUi } from '../store.js';
import { Button, Card } from './ui.js';

type WorkspaceMode = SettingsResult['workspace']['mode'];

const STORAGE_LABELS: Record<SettingsResult['storage']['items'][number]['id'], string> = {
  'search-index': '文件搜索索引',
  sessions: '会话记录',
  recovery: '文件恢复点',
  logs: '日志',
  config: '配置',
};

const INDEX_STATE: Record<SettingsResult['storage']['index']['roots'][number]['state'], string> = {
  cold: '未建立',
  building: '建立中',
  ready: '可用',
  stale: '待刷新',
  failed: '失败',
};

export function SecurityView(): ReactNode {
  const status = useUi((state) => state.status);
  const [settings, setSettings] = useState<SettingsResult>();
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('choose');
  const [defaultPath, setDefaultPath] = useState<string>();
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const applySettings = (next: SettingsResult): void => {
    setSettings(next);
    setWorkspaceMode(next.workspace.mode);
    setDefaultPath(next.workspace.defaultPath);
    setDisabledTools(new Set(next.tools.filter((tool) => !tool.enabled).map((tool) => tool.name)));
  };

  useEffect(() => {
    let active = true;
    void api.settings().then(
      (result) => { if (active) applySettings(result); },
      (cause: unknown) => { if (active) setError(errorText(cause)); },
    );
    return () => { active = false; };
  }, []);

  const dirty = useMemo(() => {
    if (settings === undefined) return false;
    const originalDisabled = settings.tools.filter((tool) => !tool.enabled).map((tool) => tool.name).sort();
    return workspaceMode !== settings.workspace.mode
      || defaultPath !== settings.workspace.defaultPath
      || JSON.stringify([...disabledTools].sort()) !== JSON.stringify(originalDisabled);
  }, [defaultPath, disabledTools, settings, workspaceMode]);

  const save = async (): Promise<void> => {
    if (workspaceMode === 'fixed' && defaultPath === undefined) {
      setError('固定目录模式需要先选择一个目录。');
      return;
    }
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const next = await api.updateSettings({
        workspace: {
          mode: workspaceMode,
          ...(defaultPath === undefined ? {} : { defaultPath }),
        },
        disabledTools: [...disabledTools],
      });
      applySettings(next);
      setMessage('设置已保存，新任务会使用新的工作目录和工具配置。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const chooseFixedDirectory = async (): Promise<void> => {
    try {
      const picked = (await api.chooseWorkspace()).path;
      if (picked !== undefined) {
        setDefaultPath(picked);
        setWorkspaceMode('fixed');
      }
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const clearIndex = async (): Promise<void> => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    setError(undefined);
    try {
      const next = await api.clearSearchIndex();
      applySettings(next);
      setMessage('文件搜索索引已清理。项目文件、会话和恢复点均未删除。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  return (
    <main className={cn(COLUMN, 'py-8')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-title font-semibold text-fg">设置与安全</h1>
          <p className="mt-1.5 text-meta text-muted">管理新任务的工作目录、工具和本地存储。</p>
        </div>
        <Button disabled={!dirty || saving} onClick={() => { void save(); }}>
          {saving ? '保存中…' : '保存设置'}
        </Button>
      </div>

      {error !== undefined && <Notice tone="danger">{error}</Notice>}
      {message !== undefined && <Notice>{message}</Notice>}

      {settings === undefined ? (
        <p className="mt-8 text-body text-muted">正在读取设置…</p>
      ) : (
        <div className="mt-7 space-y-8">
          <SettingsSection title="新任务工作目录" description="决定未明确指定目录的新任务在哪里运行，也决定文件搜索索引的扫描范围。">
            <div className="grid gap-2 md:grid-cols-3">
              <ModeCard mode="choose" selected={workspaceMode} onSelect={setWorkspaceMode} title="每次选择" detail="推荐。新任务开始前选择一个具体项目目录。" />
              <ModeCard mode="fixed" selected={workspaceMode} onSelect={setWorkspaceMode} title="固定目录" detail="所有未指定目录的新任务使用同一个目录。" />
              <ModeCard mode="home" selected={workspaceMode} onSelect={setWorkspaceMode} title="用户目录" detail="会扫描较大范围，不推荐作为日常默认值。" warning />
            </div>
            {workspaceMode === 'fixed' && (
              <div className="mt-3 flex items-center gap-2 rounded-card border border-border bg-surface-2 p-3">
                <code className="min-w-0 flex-1 truncate text-meta text-muted">{defaultPath ?? '尚未选择目录'}</code>
                <Button variant="secondary" size="sm" onClick={() => { void chooseFixedDirectory(); }}>选择目录</Button>
              </div>
            )}
          </SettingsSection>

          <SettingsSection title="模型与 Provider" description="完整的模型、服务地址和 API Key 管理归入 M3 配置中心。">
            <Card className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium">当前：{status?.providerId ?? '未知'} / {status?.model ?? '未知'}</p>
                <p className="mt-1 text-meta text-muted">API Key：{status?.hasApiKey === true ? '已配置' : '未配置'}；本版仅展示，不在这里修改。</p>
              </div>
              <span className="rounded-chip bg-surface-2 px-2.5 py-1 text-micro text-muted">M3</span>
            </Card>
          </SettingsSection>

          <SettingsSection title="本地存储" description="只有文件搜索索引可安全清理；其他数据目前仅展示占用。">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {settings.storage.items.map((item) => (
                <Card key={item.id}>
                  <p className="text-meta text-muted">{STORAGE_LABELS[item.id]}</p>
                  <p className="mt-1 text-body font-semibold tabular-nums">{formatBytes(item.bytes)}</p>
                  <p className="mt-1 text-micro text-faint">{item.clearable ? '可安全重建' : '保留'}</p>
                </Card>
              ))}
            </div>
            <Card className="mt-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-medium">文件搜索索引</h3>
                  <p className="mt-1 text-meta text-muted">清理后搜索会暂时回退；进入具体项目时可重新建立。</p>
                </div>
                <Button
                  variant={confirmClear ? 'danger' : 'secondary'}
                  size="sm"
                  disabled={clearing}
                  onBlur={() => { setConfirmClear(false); }}
                  onClick={() => { void clearIndex(); }}
                >
                  {clearing ? '清理中…' : confirmClear ? '确认清理索引' : '清理索引'}
                </Button>
              </div>
              {settings.storage.index.roots.length === 0 ? (
                <p className="mt-3 text-meta text-muted">当前没有已登记的工作区索引。</p>
              ) : (
                <ul className="mt-3 divide-y divide-border">
                  {settings.storage.index.roots.map((root) => (
                    <li key={root.root} className="flex items-center gap-3 py-2 text-meta">
                      <code className="min-w-0 flex-1 truncate text-muted" title={root.root}>{root.root}</code>
                      <span>{INDEX_STATE[root.state]}</span>
                      <span className="tabular-nums text-faint">{root.fileCount.toLocaleString()} 个文件</span>
                      <span className="w-16 text-right tabular-nums text-faint">{formatBytes(root.sourceBytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 break-all text-micro text-faint">数据目录：{settings.storage.dataDirectory}</p>
            </Card>
          </SettingsSection>

          <SettingsSection title="工具" description="关闭后，小明不会在后续回合看到或调用该工具。平台不支持的工具无法启用。">
            {settings.tools.length === 0 && (
              <p className="rounded-card border border-border bg-surface p-3 text-meta text-muted">
                当前 profile 未装载任何工具；对话与会话恢复仍可正常使用。
              </p>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              {settings.tools.map((tool) => {
                const enabled = !disabledTools.has(tool.name);
                return (
                  <label key={tool.name} className={cn('flex gap-3 rounded-card border border-border p-3', !tool.available && 'opacity-55')}>
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--color-accent)]"
                      checked={enabled && tool.available}
                      disabled={!tool.available}
                      onChange={(event) => {
                        setDisabledTools((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.delete(tool.name); else next.add(tool.name);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{toolLabel(tool.name)}</span>
                      <span className="mt-0.5 block text-meta text-muted">{tool.description}</span>
                      <code className="mt-1 block text-micro text-faint">{tool.name}{tool.available ? '' : ' · 当前平台不可用'}</code>
                    </span>
                  </label>
                );
              })}
            </div>
          </SettingsSection>

          <SettingsSection title="安全边界" description="这些是当前运行时状态；内置核心保护不能在设置页关闭。">
            <div className="grid gap-3 md:grid-cols-2">
              <InfoList title="不可覆盖保护" items={status?.security.protectedResources ?? []} />
              <InfoList title="配置问题" items={(status?.configProblems ?? []).map((problem) => problem.message)} empty="未发现配置问题" />
            </div>
          </SettingsSection>
        </div>
      )}
    </main>
  );
}

function SettingsSection({ title, description, children }: { readonly title: string; readonly description: string; readonly children: ReactNode }): ReactNode {
  return <section><h2 className="text-body font-semibold">{title}</h2><p className="mt-1 text-meta text-muted">{description}</p><div className="mt-3">{children}</div></section>;
}

function ModeCard({ mode, selected, onSelect, title, detail, warning = false }: { readonly mode: WorkspaceMode; readonly selected: WorkspaceMode; readonly onSelect: (mode: WorkspaceMode) => void; readonly title: string; readonly detail: string; readonly warning?: boolean }): ReactNode {
  return <button type="button" onClick={() => { onSelect(mode); }} className={cn('rounded-card border p-3 text-left', selected === mode ? 'border-accent bg-accent-weak' : 'border-border bg-surface hover:border-border-strong')}><span className="font-medium">{title}</span>{warning && <span className="ml-2 text-micro text-danger">不推荐</span>}<span className="mt-1 block text-meta text-muted">{detail}</span></button>;
}

function Notice({ children, tone = 'default' }: { readonly children: ReactNode; readonly tone?: 'default' | 'danger' }): ReactNode {
  return <div className={cn('mt-4 rounded-card border px-3 py-2 text-meta', tone === 'danger' ? 'border-danger-border bg-danger-bg text-danger' : 'border-border bg-surface text-muted')}>{children}</div>;
}

function InfoList({ title, items, empty = '无' }: { readonly title: string; readonly items: readonly string[]; readonly empty?: string }): ReactNode {
  return <Card><h3 className="font-medium">{title}</h3>{items.length === 0 ? <p className="mt-2 text-meta text-muted">{empty}</p> : <ul className="mt-2 list-disc space-y-1 pl-5 text-meta text-muted">{items.map((item) => <li key={item}>{item}</li>)}</ul>}</Card>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0] ?? 'KiB';
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    'fs.read': '读取文件', 'fs.write': '写入文件', 'fs.list': '浏览目录',
    'search.text': '搜索文本', 'search.symbol': '搜索代码符号',
    'shell.exec': '运行本地命令', 'shell.session.open': '打开终端会话',
    'web.fetch': '访问网页', 'agent.explore': '只读子 Agent',
    'edit.preview': '预览精确编辑', 'edit.apply': '应用精确编辑',
    'git.status': '查看 Git 状态', 'git.diff': '查看 Git 差异',
    'git.commit': '创建 Git 提交', 'git.stage': '暂存 Git 文件',
  };
  return labels[name] ?? name;
}

const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
