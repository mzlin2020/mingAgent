/**
 * 脱敏。日志与审计**强制**经过它（docs/10 §8）。
 *
 * 这是对参考项目 2.6（config.yaml 含真实 API key 且已提交进 git）的运行时侧回应：
 * 配置里只允许出现 SecretRef，真值由 SecretStore 在使用点解析——但解析后的值
 * 会流经日志、审计、事件 payload，所以必须有一道统一的出口过滤。
 *
 * **定位是尽力而为，不是保证。** 不做高熵检测：误报率高到会被人整体关掉，
 * 等于不存在。宁可漏掉罕见形态，也要保证这道过滤一直开着。
 */

export const REDACTED = '***';

/** 键名命中即整体替换值，不看值长什么样 */
const SENSITIVE_KEY =
  /(?:api[_-]?key|apikey|secret|token|password|passwd|credential|authorization|cookie|private[_-]?key)/i;

/** 值本身长得像密钥时，即使键名无辜也要脱敏（如 argv 数组里的裸 key） */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[a-z0-9]{3,}-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END [^-]*-----/g,
];

const redactString = (s: string): string => {
  let out = s;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
};

/**
 * 递归脱敏。返回 `unknown` 而不是保形的泛型——因为它确实改变了值的内容，
 * 假装类型不变会诱使调用方把脱敏结果当原值用。
 *
 * 循环引用安全（用 WeakSet 兜底），因为审计对象可能来自任意工具的输出。
 */
export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>(), 0);
}

const MAX_DEPTH = 32;

function redactInner(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[脱敏：嵌套过深]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[脱敏：循环引用]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactInner(v, seen, depth + 1);
  }
  return out;
}
