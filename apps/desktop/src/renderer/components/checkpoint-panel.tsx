import { useState, type ReactNode } from 'react';
import type { Checkpoint } from '@xm/kernel';
import { api } from '../bridge.js';
import { Button, Card } from './ui.js';

export function CheckpointPanel({
  sessionId,
  checkpoints,
}: {
  readonly sessionId: string;
  readonly checkpoints: readonly Checkpoint[];
}): ReactNode {
  const [busyId, setBusyId] = useState<string>();
  const [detail, setDetail] = useState<{ readonly id: string; readonly text: string }>();
  const [error, setError] = useState<string>();
  if (checkpoints.length === 0) return null;

  const inspect = async (checkpoint: Checkpoint): Promise<void> => {
    setBusyId(checkpoint.checkpointId);
    setError(undefined);
    try {
      const manifest = await api.inspectCheckpoint(sessionId, checkpoint.checkpointId);
      const files = manifest.targets.reduce(
        (count, target) => count + (target.kind === 'directory' ? target.entries.length : 1),
        0,
      );
      setDetail({
        id: checkpoint.checkpointId,
        text: `${String(manifest.targets.length)} 个目标，${String(files)} 个恢复条目`,
      });
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <Card className="p-0">
      <div className="border-b border-border px-3.5 py-2.5 font-medium">还原点</div>
      <ul className="flex flex-col py-1" aria-label="还原点">
        {checkpoints.toReversed().map((checkpoint) => {
          const interrupted = checkpoint.restoreStartedAt !== undefined;
          const status = checkpoint.restoredAt !== undefined
            ? '已恢复'
            : checkpoint.restoreFailure !== undefined
              ? '恢复失败，可重试'
              : interrupted
                ? '恢复中断，可重试'
                : '可恢复';
          return (
            <li key={checkpoint.checkpointId} className="flex items-start gap-3 px-3.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body">{checkpoint.label}</div>
                <div className="text-meta text-muted">
                  {status}
                  {detail?.id === checkpoint.checkpointId ? ` · ${detail.text}` : ''}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busyId !== undefined || checkpoint.manifestRef === undefined}
                onClick={() => void inspect(checkpoint)}
              >
                详情
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busyId !== undefined || checkpoint.restoredAt !== undefined || checkpoint.manifestRef === undefined}
                onClick={() => void restore(checkpoint)}
              >
                撤销
              </Button>
            </li>
          );
        })}
      </ul>
      {error !== undefined && <div className="border-t border-danger-border px-3.5 py-2 text-meta text-danger">{error}</div>}
    </Card>
  );
}
