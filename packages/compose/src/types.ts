import { z } from 'zod';
import type { ContainerPlugin, PluginContainer } from '@xm/kernel';

const Name = z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const PluginReference = z.string().min(3).regex(/^@[^#]+#[A-Za-z0-9._-]+$/u);
const ServiceName = z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9._-]*$/u);

export const ProfileRowSchema = z.strictObject({
  id: Name,
  plugin: PluginReference,
  inject: z.array(ServiceName),
  provide: z.array(ServiceName),
  config: z.unknown().optional(),
});

export const ProfileSchema = z.strictObject({
  name: Name,
  rows: z.array(ProfileRowSchema),
});

const ProfileUpdateSchema = z.strictObject({
  id: Name,
  config: z.unknown(),
});

const ProfileInsertSchema = z.union([
  z.strictObject({ before: Name, row: ProfileRowSchema }),
  z.strictObject({ after: Name, row: ProfileRowSchema }),
]);

export const ProfilePatchSchema = z.strictObject({
  update: z.array(ProfileUpdateSchema).optional(),
  insert: z.array(ProfileInsertSchema).optional(),
});

export type ProfileRow = z.infer<typeof ProfileRowSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

export type PluginFactory<S extends object> = (row: ProfileRow) => ContainerPlugin<S>;
export type PluginCatalog<S extends object> = Record<string, PluginFactory<S>>;

export interface AssembledProfile<S extends object> {
  readonly container: PluginContainer<S>;
  readonly profile: Profile;
  readonly rows: readonly ProfileRow[];
  dispose(): Promise<void>;
}

export class ProfileError extends Error {
  override readonly name = 'ProfileError';
}

export class ProfileAssemblyError extends Error {
  override readonly name = 'ProfileAssemblyError';
  readonly rowId: string;
  readonly plugin: string;

  constructor(rowId: string, plugin: string, detail: string) {
    super(`profile 行 "${rowId}"（${plugin}）${detail}`);
    this.rowId = rowId;
    this.plugin = plugin;
  }
}
