import { describe, expect, it } from 'vitest';
import type { CheckpointManifestV2 } from '@xm/contracts';
import { checkpointImpact, checkpointTargetText } from '../src/renderer/lib/checkpoint-display.js';

describe('checkpoint display', () => {
  it('明确区分覆盖旧内容与移除新建项目', () => {
    const manifest: CheckpointManifestV2 = {
      version: 2,
      targets: [
        { kind: 'missing', path: 'src/new.ts' },
        {
          kind: 'file',
          path: 'README.md',
          content: { hash: 'a'.repeat(64), size: 10, mime: 'text/plain' },
        },
      ],
    };

    expect(checkpointImpact(manifest)).toEqual({
      targetCount: 2,
      entryCount: 2,
      removesCreatedTargets: true,
    });
    expect(checkpointTargetText(manifest.targets[0]!)).toBe('修改前不存在，恢复时会移除');
    expect(checkpointTargetText(manifest.targets[1]!)).toBe('恢复修改前的文件内容');
  });

  it('目录条目计入恢复影响', () => {
    const manifest: CheckpointManifestV2 = {
      version: 2,
      targets: [
        {
          kind: 'directory',
          path: 'src',
          entries: [
            { kind: 'directory', path: 'components' },
            { kind: 'symlink', path: 'latest', link: 'components' },
          ],
        },
      ],
    };

    expect(checkpointImpact(manifest)).toEqual({
      targetCount: 1,
      entryCount: 2,
      removesCreatedTargets: false,
    });
    expect(checkpointTargetText(manifest.targets[0]!)).toBe('恢复修改前的目录内容（2 项）');
  });
});
