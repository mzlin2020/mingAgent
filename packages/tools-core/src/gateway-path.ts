import { realpath as realpathCallback } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { normalizePathTarget } from '@xm/kernel';
import { GatewayError } from '@xm/kernel';

const realpath = promisify(realpathCallback.native);

export function canonicalPath(nativePath: string, tool: string, field: string): string {
  const stripped = nativePath.replace(/^\\\\\?\\(UNC\\)?/, (_match, unc: string | undefined) =>
    unc === undefined ? '' : '\\\\',
  );
  if (/^[\\/]{2}/.test(stripped)) {
    throw new GatewayError(
      `工具 ${tool} 的入参 "${field}" 指向 UNC 网络路径（${nativePath}），当前无法安全归一。`,
      { tool, field, path: nativePath },
    );
  }
  const normalized = normalizePathTarget(stripped);
  if (!normalized.ok) {
    throw new GatewayError(
      `工具 ${tool} 的入参 "${field}" 解析出的路径 "${nativePath}" 无法规范化：${normalized.reason}`,
      { tool, field, path: nativePath },
    );
  }
  return normalized.value;
}

/** 从最深的已存在祖先起解析符号链接与 junction。 */
export async function resolveDeepPath(absolute: string): Promise<string> {
  const rest: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch (error) {
      if (!isNotFound(error)) {
        throw new GatewayError(`无法解析路径 "${absolute}"：${describe(error)}`, { path: absolute });
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new GatewayError(`无法解析路径 "${absolute}"：向上到根都不存在或不可访问。`, {
          path: absolute,
        });
      }
      rest.push(cursor.slice(parent.length).replaceAll(sep, ''));
      cursor = parent;
    }
  }
}

export function asInputRecord(input: unknown, toolName: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GatewayError(`工具 ${toolName} 的入参不是对象，无法读取受控字段。`, { tool: toolName });
  }
  return input as Record<string, unknown>;
}

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
