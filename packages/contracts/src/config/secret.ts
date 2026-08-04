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
