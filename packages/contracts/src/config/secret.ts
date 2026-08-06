import { z } from 'zod';

/**
 * 密钥引用。**配置里永远不出现明文密钥**，只出现 SecretRef，
 * 由 SecretStore 在使用点解析。
 *
 * 这是对参考项目 2.6 的直接回应：那边的 `api/config.yaml` 含真实 API key 且已提交进
 * git 历史——文件改掉都不够，得重写历史。所以密钥不能有"暂时写在配置里"这条路径。
 *
 * 配套三件事：
 *   1. redact() 强制作用于日志与审计（base/redact.ts）
 *   2. 提交前密钥扫描（scripts/check-secrets.mjs）
 *   3. SecretStore 退化（如 Linux 无 keyring）必须发 notice 事件显式告知，绝不静默明文
 */
export const SecretRef = z.strictObject({
  /** 钥匙串里的条目名，如 "anthropic.apiKey" */
  $secret: z.string().min(1),
});
export type SecretRef = z.infer<typeof SecretRef>;

export const isSecretRef = (v: unknown): v is SecretRef => SecretRef.safeParse(v).success;

/**
 * 配置里出现明文密钥的键名。
 *
 * 与 `redact.ts` 的 `SENSITIVE_KEY` 是**两件事**，不要合并：那一条管的是"值流出去之前
 * 遮住它"，尽力而为；这一条管的是"这个值根本不该被写进配置文件"，失败关闭。
 * 前者宁可漏报也不能误报（误报会让人把脱敏整个关掉），后者宁可误报也不能漏报
 * （漏报的后果就是参考项目那个含真实 key 且已提交进 git 的 config.yaml）。
 */
const SECRET_KEY = /^(?:api[_-]?key|apikey|secret|token|password|passwd|credential)$/i;

export interface PlaintextSecretFinding {
  /** 点分路径，如 `providers.anthropic.apiKey` */
  readonly path: string;
}

/**
 * 扫出配置里的明文密钥。**在 Zod 校验之前跑。**
 *
 * 顺序有理由：`apiKey` 的 schema 是 `SecretRef`（strictObject），明文字符串本来就过不了，
 * 但 zod 会说「期望对象，收到字符串」——那句话不会让人想到"你把密钥写进配置文件了，
 * 而这个文件很可能会被提交"。校验器负责挡住，这个函数负责**说清楚挡的是什么**。
 *
 * 只看键名不看值：一个短到不像密钥的字符串，同样不该出现在这里。
 */
export function findPlaintextSecrets(value: unknown, prefix = ''): PlaintextSecretFinding[] {
  if (typeof value !== 'object' || value === null) return [];

  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findPlaintextSecrets(v, `${prefix}[${String(i)}]`));
  }

  const out: PlaintextSecretFinding[] = [];
  for (const [key, v] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (SECRET_KEY.test(key) && typeof v === 'string') {
      out.push({ path });
      continue;
    }
    out.push(...findPlaintextSecrets(v, path));
  }
  return out;
}
