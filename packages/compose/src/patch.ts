import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builtinProfile, type BuiltinProfileName } from './profiles.js';
import {
  ProfileError,
  ProfilePatchSchema,
  ProfileSchema,
  type Profile,
  type ProfilePatch,
  type ProfileRow,
} from './types.js';

const assertUniqueRows = (rows: readonly ProfileRow[]): void => {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new ProfileError(`profile 行 id 重复：${row.id}`);
    ids.add(row.id);
  }
};

export const applyProfilePatch = (input: Profile, rawPatch: ProfilePatch): Profile => {
  const profile = ProfileSchema.parse(input);
  const patch = ProfilePatchSchema.parse(rawPatch);
  const rows = profile.rows.map((row) => ({ ...row }));
  assertUniqueRows(rows);

  for (const update of patch.update ?? []) {
    const index = rows.findIndex((row) => row.id === update.id);
    if (index < 0) throw new ProfileError(`patch 引用了不存在的行：${update.id}`);
    if (update.id.startsWith('baseline.')) {
      throw new ProfileError(`基线行 ${update.id} 不可 patch。`);
    }
    const current = rows[index];
    if (current === undefined) throw new ProfileError(`patch 行丢失：${update.id}`);
    rows[index] = { ...current, config: structuredClone(update.config) };
  }

  for (const insert of patch.insert ?? []) {
    const row = insert.row;
    if (row.id.startsWith('baseline.')) {
      throw new ProfileError(`用户 patch 不能插入基线行：${row.id}`);
    }
    if (rows.some((candidate) => candidate.id === row.id)) {
      throw new ProfileError(`patch 插入了重复行：${row.id}`);
    }
    const anchor = 'before' in insert ? insert.before : insert.after;
    const anchorIndex = rows.findIndex((candidate) => candidate.id === anchor);
    if (anchorIndex < 0) throw new ProfileError(`patch 锚点不存在：${anchor}`);
    if (anchor.startsWith('baseline.')) {
      throw new ProfileError(`用户 patch 不能在基线行 ${anchor} 之间插入。`);
    }
    rows.splice('before' in insert ? anchorIndex : anchorIndex + 1, 0, structuredClone(row));
  }

  assertUniqueRows(rows);
  return { name: profile.name, rows };
};

export const loadPatchedProfile = async (options: {
  readonly name: BuiltinProfileName;
  readonly configDir: string;
}): Promise<Profile> => {
  const profile = builtinProfile(options.name);
  const path = join(options.configDir, 'profiles', `${options.name}.patch.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return profile;
    throw error;
  }
  try {
    return applyProfilePatch(profile, ProfilePatchSchema.parse(JSON.parse(raw) as unknown));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProfileError(`读取 profile patch 失败（${path}）：${detail}`);
  }
};

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
