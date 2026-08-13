import { resolve } from 'node:path';
import type { RegisteredTool } from '@xm/kernel';
import { GatewayError } from '@xm/kernel';
import { asInputRecord, canonicalPath, resolveDeepPath } from './gateway-path.js';

/** 解析普通 `path` 与 M2-d 的窄数组语法 `files[].path`，并把规范化结果回写。 */
export async function resolvePathFields(
  tool: RegisteredTool,
  record: Record<string, unknown>,
  cwd: string,
): Promise<{ readonly input: Record<string, unknown>; readonly targets: readonly string[] }> {
  const out: Record<string, unknown> = { ...record };
  const targets: string[] = [];
  for (const declaration of tool.pathInputs) {
    const nested = /^([a-zA-Z0-9_]+)\[\]\.([a-zA-Z0-9_]+)$/u.exec(declaration);
    if (nested === null) {
      const raw = record[declaration];
      if (raw === undefined) continue;
      const resolved = await resolvePathValue(raw, cwd, tool.descriptor.name, declaration);
      out[declaration] = resolved;
      targets.push(resolved);
      continue;
    }

    const [, arrayField, pathField] = nested;
    if (arrayField === undefined || pathField === undefined) {
      throw new GatewayError(`工具 ${tool.descriptor.name} 的 pathInputs 声明不合法。`, {
        tool: tool.descriptor.name,
        field: declaration,
      });
    }
    const rawArray = record[arrayField];
    if (!Array.isArray(rawArray)) {
      throw new GatewayError(
        `工具 ${tool.descriptor.name} 的入参 "${arrayField}" 应当是对象数组。`,
        { tool: tool.descriptor.name, field: declaration },
      );
    }
    const resolvedItems: unknown[] = [];
    for (const [index, item] of rawArray.entries()) {
      const itemRecord = asInputRecord(item, tool.descriptor.name);
      const resolved = await resolvePathValue(
        itemRecord[pathField],
        cwd,
        tool.descriptor.name,
        `${arrayField}[${String(index)}].${pathField}`,
      );
      resolvedItems.push({ ...itemRecord, [pathField]: resolved });
      targets.push(resolved);
    }
    out[arrayField] = resolvedItems;
  }
  return { input: out, targets };
}

async function resolvePathValue(
  raw: unknown,
  cwd: string,
  toolName: string,
  field: string,
): Promise<string> {
  if (typeof raw !== 'string' || raw === '') {
    throw new GatewayError(
      `工具 ${toolName} 的入参 "${field}" 应当是一个非空路径字符串。`,
      { tool: toolName, field },
    );
  }
  return canonicalPath(await resolveDeepPath(resolve(cwd, raw)), toolName, field);
}
