import { useEffect, useState, type ReactNode } from 'react';
import { reviewHunksOfFile } from '@xm/contracts';
import type { EditProposalState } from '@xm/kernel';
import { api } from '../bridge.js';
import { allHunkIds, boundedDiff, latestPendingProposal } from '../lib/diff-review.js';
import { Button, Card } from './ui.js';

export function DiffReviewPanel({
  sessionId,
  proposals,
}: {
  readonly sessionId: string;
  readonly proposals: readonly EditProposalState[];
}): ReactNode {
  const pending = latestPendingProposal(proposals);
  const proposalId = pending?.proposal.proposalId;
  const [activeFile, setActiveFile] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setActiveFile(0);
    setSelected(new Set(pending === undefined ? [] : allHunkIds(pending)));
    setError(undefined);
  }, [proposalId]);

  if (pending === undefined) return null;
  const file = pending.proposal.files[activeFile] ?? pending.proposal.files[0];
  if (file === undefined) return null;
  const hunks = reviewHunksOfFile(file, activeFile);

  const submit = async (ids: readonly string[]): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.reviewEditProposal(sessionId, pending.proposal.proposalId, ids);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-0" tone="accent">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <div>
          <div className="font-medium">Diff 审阅</div>
          <div className="text-meta text-muted">选择要应用的改动块；这不是权限审批。</div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void submit([])}>
            拒绝全部
          </Button>
          <Button
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => void submit([...selected])}
          >
            应用选中
          </Button>
        </div>
      </div>
      <div className="flex min-h-0">
        <ul className="w-44 shrink-0 border-r border-border py-1" aria-label="变更文件">
          {pending.proposal.files.map((candidate, index) => (
            <li key={candidate.path}>
              <button
                type="button"
                className="w-full truncate px-3 py-1.5 text-left text-meta hover:bg-surface-2"
                onClick={() => {
                  setActiveFile(index);
                }}
              >
                {candidate.path.replaceAll('\\', '/').split('/').at(-1)}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1 p-3">
          <div className="mb-2 truncate text-meta text-muted">{file.path}</div>
          <div className="flex flex-col gap-3">
            {hunks.map((hunk) => {
              const view = boundedDiff(hunk.diff);
              return (
                <label key={hunk.hunkId} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(hunk.hunkId)}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.currentTarget.checked) next.add(hunk.hunkId);
                      else next.delete(hunk.hunkId);
                      setSelected(next);
                    }}
                  />
                  <pre className="min-w-0 flex-1 overflow-x-auto bg-surface-2 p-2 font-mono text-meta">
                    {view.lines.join('\n')}
                    {view.truncated ? '\n… diff 过大，仅显示前 400 行' : ''}
                  </pre>
                </label>
              );
            })}
          </div>
        </div>
      </div>
      {error !== undefined && (
        <div className="border-t border-danger-border px-3.5 py-2 text-meta text-danger">{error}</div>
      )}
    </Card>
  );
}
