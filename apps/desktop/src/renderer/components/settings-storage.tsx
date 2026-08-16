import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SettingsResult } from '../../shared/ipc.js';
import { api } from '../bridge.js';
import { errorText, formatBytes } from '../lib/settings-request.js';
import { Button, Card, SettingsNotice, SettingsSection } from './settings-kit.js';

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

export function SettingsStorage({
  settings,
  onApplied,
}: {
  readonly settings: SettingsResult;
  readonly onApplied: (next: SettingsResult) => void;
}): ReactNode {
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const clearIndex = async (): Promise<void> => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    setError(undefined);
    try {
      onApplied(await api.clearSearchIndex());
      setMessage('文件搜索索引已清理。项目文件、会话和恢复点均未删除。');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  return (
    <div className="space-y-4">
      {error !== undefined && <SettingsNotice tone="danger">{error}</SettingsNotice>}
      {message !== undefined && <SettingsNotice>{message}</SettingsNotice>}
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
    </div>
  );
}

export function SettingsAbout({ settings }: { readonly settings: SettingsResult }): ReactNode {
  return (
    <SettingsSection title="关于与安全边界" description="这些是当前运行时状态；内置核心保护不能在设置页关闭。">
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <h3 className="font-medium">版本</h3>
          <p className="mt-2 text-meta text-muted">{settings.meta.version}</p>
          <p className="mt-1 text-micro text-faint">密钥后端：{settings.meta.secretBackend}</p>
        </Card>
        <Card>
          <h3 className="font-medium">配置问题</h3>
          {settings.meta.configProblems.length === 0 ? (
            <p className="mt-2 text-meta text-muted">未发现配置问题</p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-meta text-muted">
              {settings.meta.configProblems.map((problem) => (
                <li key={problem.code + problem.message}>{problem.message}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="mt-4 text-meta text-muted">
        日志脱敏是安全底座，不可配置。权限判定只有允许与拒绝，没有「问用户」。
      </p>
    </SettingsSection>
  );
}
