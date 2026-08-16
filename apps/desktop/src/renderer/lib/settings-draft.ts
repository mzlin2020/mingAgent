/**
 * 设置页草稿侧的纯函数：生成不重复的 id、解析价目输入。
 * 不碰 IPC、不碰磁盘。
 */

export const IMPLEMENTED_PROVIDER_KINDS = ['anthropic', 'openai', 'openai-compatible'] as const;
export type ImplementedProviderKind = (typeof IMPLEMENTED_PROVIDER_KINDS)[number];

export function isImplementedProviderKind(kind: string): kind is ImplementedProviderKind {
  return (IMPLEMENTED_PROVIDER_KINDS as readonly string[]).includes(kind);
}

export function providerKindOptions<K extends string>(current: K): readonly (ImplementedProviderKind | K)[] {
  if (isImplementedProviderKind(current)) return IMPLEMENTED_PROVIDER_KINDS;
  return [...IMPLEMENTED_PROVIDER_KINDS, current];
}

/** 已占用则追加 -2、-3…；调用方保证 base 本身不超过字段上限。 */
export function uniqueRecordKey(existing: ReadonlySet<string> | readonly string[], base: string): string {
  const used = existing instanceof Set ? existing : new Set(existing);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${String(n)}`)) n += 1;
  return `${base}-${String(n)}`;
}

/**
 * 拒绝规则 id 最长 80。必须先为后缀留位置再截断，
 * 否则两条长 glob 会得到同一个 id，或 `${base}-2`.slice(0, 80) 仍等于 base。
 */
export function uniqueDenyRuleId(capability: string, target: string, existing: ReadonlySet<string>): string {
  const raw = `user.deny.${capability}${target.trim() === '' ? '' : `.${target.trim()}`}`.replace(/[^\w.*-]+/g, '-');
  const fit = (value: string): string => value.slice(0, 80);
  const first = fit(raw);
  if (!existing.has(first)) return first;
  let n = 2;
  for (;;) {
    const suffix = `-${String(n)}`;
    const next = fit(raw.slice(0, Math.max(0, 80 - suffix.length)) + suffix);
    if (!existing.has(next)) return next;
    n += 1;
  }
}

/**
 * 价目受控框：未写完的小数（`3.`）返回 undefined，调用方只更新本地字符串。
 * 空串当成 0——删数字应走「删除」按钮，不是把单价留在半空状态。
 */
export function parsePriceField(raw: string): number | undefined {
  const text = raw.trim();
  if (text === '') return 0;
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text)) return undefined;
  if (text.endsWith('.')) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
