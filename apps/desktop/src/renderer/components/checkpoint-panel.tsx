import { useState, type ReactNode } from 'react';
import type { CheckpointManifestV2 } from '@xm/contracts';
import type { Checkpoint } from '@xm/kernel';
import { api } from '../bridge.js';
import { checkpointImpact, checkpointTargetText } from '../lib/checkpoint-display.js';
import { Button, Card } from './ui.js';

export function CheckpointPanel({
  sessionId,
  checkpoints,
}: {
  readonly sessionId: string;
  readonly checkpoints: readonly Checkpoint[];
}): ReactNode {
  const [busyId, setBusyId] = useState<string>();
  const [details, setDetails] = useState<ReadonlyMap<string, CheckpointManifestV2>>(new Map());
  const [expandedId, setExpandedId] = useState<string>();
  const [confirmId, setConfirmId] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string>();
  if (checkpoints.length === 0) return null;
  const ordered = checkpoints.toReversed();
  const visible = showAll ? ordered : ordered.slice(0, 3);

  const inspect = async (checkpoint: Checkpoint): Promise<void> => {
    if (expandedId === checkpoint.checkpointId) {
      setExpandedId(undefined);
      setConfirmId(undefined);
      return;
    }
    setExpandedId(checkpoint.checkpointId);
    setConfirmId(undefined);
    if (details.has(checkpoint.checkpointId)) return;
    setBusyId(checkpoint.checkpointId);
    setError(undefined);
    try {
      const manifest = await api.inspectCheckpoint(sessionId, checkpoint.checkpointId);
      setDetails((current) => new Map(current).set(checkpoint.checkpointId, manifest));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  const restore = async (checkpoint: Checkpoint): Promise<void> => {
    setBusyId(checkpoint.checkpointId);
    setError(undefined);
    try {
      await api.restoreCheckpoint(sessionId, checkpoint.checkpointId);
      setConfirmId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <Card className="p-0">
      <div className="border-b border-border px-3.5 py-2.5">
        <div className="font-medium">文件恢复</div>
        <div className="text-meta text-muted">需要时可把单次文件操作恢复到执行前。</div>
      </div>
      <ul className="flex flex-col py-1" aria-label="文件恢复记录">
        {visible.map((checkpoint) => {
          const manifest = details.get(checkpoint.checkpointId);
          const impact = manifest === undefined ? undefined : checkpointImpact(manifest);
          const expanded = expandedId === checkpoint.checkpointId;
          const interrupted = checkpoint.restoreStartedAt !== undefined;
          const status = checkpoint.restoredAt !== undefined
            ? '已恢复到修改前'
            : checkpoint.restoreFailure !== undefined
              ? '恢复失败，可重试'
              : interrupted
                ? '恢复中断，可重试'
                : '可恢复到修改前';
          return (
            <li key={checkpoint.checkpointId} className="border-b border-border px-3.5 py-2.5 last:border-b-0">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body" title={checkpoint.label}>{checkpoint.label}</div>
                  <div className="text-meta text-muted">{status}</div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={expanded}
                  disabled={busyId !== undefined || checkpoint.manifestRef === undefined}
                  onClick={() => void inspect(checkpoint)}
                >
                  {busyId === checkpoint.checkpointId ? '读取中…' : expanded ? '收起' : '查看影响'}
                </Button>
              </div>

              {expanded && manifest !== undefined && impact !== undefined && (
                <div className="ui-expand mt-2.5 rounded-control bg-surface-2 p-2.5 text-meta">
                  <div className="mb-2 text-muted">
                    共 {impact.targetCount} 个目标、{impact.entryCount} 个恢复条目。
                  </div>
                  <ul className="flex max-h-44 flex-col gap-2 overflow-y-auto" aria-label="恢复影响">
                    {manifest.targets.map((target) => (
                      <li key={`${target.kind}:${target.path}`}>
                        <div className="break-all font-mono text-fg">{target.path}</div>
                        <div className={target.kind === 'missing' ? 'text-danger' : 'text-muted'}>
                          {checkpointTargetText(target)}
                        </div>
                      </li>
                    ))}
                  </ul>

                  {checkpoint.restoredAt === undefined && confirmId !== checkpoint.checkpointId && (
                    <Button
                      className="mt-2.5 w-full"
                      size="sm"
                      variant="secondary"
                      disabled={busyId !== undefined}
                      onClick={() => { setConfirmId(checkpoint.checkpointId); }}
                    >
                      恢复到修改前…
                    </Button>
                  )}

                  {confirmId === checkpoint.checkpointId && (
                    <div className="ui-expand mt-2.5 border-t border-border pt-2.5">
                      <p className="text-fg">
                        将覆盖当前内容
                        {impact.removesCreatedTargets ? '，并移除修改中新建的项目' : ''}。恢复后这条记录不能再次使用。
                      </p>
                      <div className="mt-2 flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => { setConfirmId(undefined); }}>
                          取消
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busyId !== undefined}
                          onClick={() => void restore(checkpoint)}
                        >
                          {busyId === checkpoint.checkpointId ? '正在恢复…' : '确认恢复'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {checkpoints.length > 3 && (
        <div className="border-t border-border p-2">
          <Button
            className="w-full"
            size="sm"
            variant="ghost"
            aria-expanded={showAll}
            onClick={() => {
              setShowAll((value) => !value);
              setExpandedId(undefined);
              setConfirmId(undefined);
            }}
          >
            {showAll ? '只看最近 3 条' : `查看更早的 ${String(checkpoints.length - 3)} 条记录`}
          </Button>
        </div>
      )}
      {error !== undefined && <div className="border-t border-danger-border px-3.5 py-2 text-meta text-danger">{error}</div>}
    </Card>
  );
}
