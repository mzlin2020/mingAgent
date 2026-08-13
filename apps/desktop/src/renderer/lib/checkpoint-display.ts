import type { CheckpointManifestV2, CheckpointTarget } from '@xm/contracts';

export interface CheckpointImpact {
  readonly targetCount: number;
  readonly entryCount: number;
  readonly removesCreatedTargets: boolean;
}
export function checkpointImpact(manifest: CheckpointManifestV2): CheckpointImpact {
  return {
    targetCount: manifest.targets.length,
    entryCount: manifest.targets.reduce(
      (count, target) => count + (target.kind === 'directory' ? target.entries.length : 1),
      0,
    ),
    removesCreatedTargets: manifest.targets.some((target) => target.kind === 'missing'),
  };
}

export function checkpointTargetText(target: CheckpointTarget): string {
  switch (target.kind) {
    case 'missing':
      return '修改前不存在，恢复时会移除';
    case 'file':
      return '恢复修改前的文件内容';
    case 'directory':
      return `恢复修改前的目录内容（${String(target.entries.length)} 项）`;
  }
}
