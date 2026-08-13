import { z } from 'zod';
import { BlobRef } from '../base/blob.js';

const RelativePath = z.string().min(1).max(4096).refine(
  (path) =>
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !/^[a-zA-Z]:/.test(path) &&
    !path.split(/[\\/]/u).includes('..'),
  '目录项路径必须是不能逃逸的相对路径',
);

export const CheckpointDirectoryEntry = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('directory'), path: RelativePath }),
  z.strictObject({ kind: z.literal('file'), path: RelativePath, content: BlobRef }),
  z.strictObject({ kind: z.literal('symlink'), path: RelativePath, link: z.string().max(4096) }),
]);
export type CheckpointDirectoryEntry = z.infer<typeof CheckpointDirectoryEntry>;

export const CheckpointTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('missing'), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1), content: BlobRef }),
  z.strictObject({
    kind: z.literal('directory'),
    path: z.string().min(1),
    entries: z.array(CheckpointDirectoryEntry),
  }),
]);
export type CheckpointTarget = z.infer<typeof CheckpointTarget>;

export const CheckpointManifestV2 = z.strictObject({
  version: z.literal(2),
  targets: z.array(CheckpointTarget).min(1),
});
export type CheckpointManifestV2 = z.infer<typeof CheckpointManifestV2>;

export const CHECKPOINT_MANIFEST_MIME = 'application/vnd.xm.checkpoint-manifest+json';
