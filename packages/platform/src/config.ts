import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, ConfigPatch } from '@xm/contracts';
import { Config as ConfigSchema, findPlaintextSecrets, mergeConfigLayers } from '@xm/contracts';
import type { XmPaths } from '@xm/kernel';

/**
 * 配置加载。
 *
 * schema、合并语义、会话补丁的越权过滤在 `@xm/contracts` 里从 M0 就写好了，
 * **但在此之前没有任何代码读过一个配置文件**——那套东西一直是纯纸面的。
 *
 * 分层（`config/schema.ts` 定的顺序）：
 *   内置默认 < 用户级 `${paths.config}/config.json` < 项目级 `${cwd}/.xiaoming/config.json`
 *
 * 环境变量这一层**刻意不做**。它在 schema 的注释里排在最后一位，但真接上就等于
 * 给了一条"把 key 塞进 env"的合法路径——而 `shell.exec`（M1-d）会把整个环境
 * 原样交给子进程。密钥的唯一来源是 SecretStore，不给第二条。
 */

export interface LoadConfigOptions {
  readonly paths: XmPaths;
  /** 项目级配置的查找起点。省略则不加载项目层 */
  readonly cwd?: string;
}

export interface LoadedConfig {
  readonly config: Config;
  /** 每一层的来源与结果，供 UI 显示"这个值是从哪来的" */
  readonly sources: readonly ConfigSource[];
  /** 加载过程中的问题。**不抛**，由调用方转成 notice 事件 */
  readonly problems: readonly ConfigProblem[];
}

export interface ConfigSource {
  readonly file: string;
  readonly loaded: boolean;
}

export interface ConfigProblem {
  readonly code: 'config.unreadable' | 'config.invalid' | 'config.plaintext_secret';
  readonly message: string;
}

/** 内置默认。是这棵树里唯一不需要文件就能拿到的一层 */
export const DEFAULT_CONFIG: ConfigPatch = {
  model: { main: 'anthropic/claude-opus-5' },
  providers: {},
  prices: {},
  permission: { tier: 'balanced', rules: [] },
  tools: { disabled: [] },
  logging: { level: 'info', redact: true },
};

/**
 * 加载并校验。**失败关闭到"内置默认"，而不是抛。**
 *
 * 取舍的理由：配置坏了不该让应用起不来——那时用户连改配置的界面都打不开。
 * 但也绝不能静默：每个问题都进 `problems`，调用方负责变成 notice 事件与常驻提示。
 * 这与 `SecretStore` 退化那条是同一个姿态：**降级可以，不告诉用户不行。**
 */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const files = [
    join(options.paths.config, 'config.json'),
    ...(options.cwd === undefined ? [] : [join(options.cwd, '.xiaoming', 'config.json')]),
  ];

  const problems: ConfigProblem[] = [];
  const sources: ConfigSource[] = [];
  const layers: ConfigPatch[] = [DEFAULT_CONFIG];

  for (const file of files) {
    const layer = await readLayer(file, problems);
    sources.push({ file, loaded: layer !== undefined });
    if (layer !== undefined) layers.push(layer);
  }

  const merged = mergeConfigLayers(...layers);

  /*
   * 明文密钥的检查**排在 schema 校验之前**。
   *
   * `apiKey` 的类型是 SecretRef（strictObject），明文字符串本来就过不了校验——
   * 但 zod 会说"期望对象，收到字符串"，而用户需要听到的是
   * "你把密钥写进了配置文件，这个文件很可能会被提交"。
   * 校验器负责挡，这一步负责说清楚挡的是什么。
   */
  for (const finding of findPlaintextSecrets(merged)) {
    problems.push({
      code: 'config.plaintext_secret',
      message:
        `配置里的 \`${finding.path}\` 是一段明文。密钥不能写在配置文件里——` +
        '请在界面里录入，配置中只保留形如 `{"$secret": "anthropic.apiKey"}` 的引用。',
    });
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (parsed.success) return { config: parsed.data, sources, problems };

  problems.push({
    code: 'config.invalid',
    message: `配置不合法，已退回内置默认：${parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')} ${i.message}`)
      .join('；')}`,
  });

  // 内置默认必须永远能过校验。过不了是我们自己的 bug，那时抛是对的
  return { config: ConfigSchema.parse(DEFAULT_CONFIG), sources, problems };
}

async function readLayer(file: string, problems: ConfigProblem[]): Promise<ConfigPatch | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    // 文件不存在是**绝大多数**情况，不是问题
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push({ code: 'config.unreadable', message: `${file} 的顶层不是一个对象，已忽略。` });
      return undefined;
    }
    return parsed as ConfigPatch;
  } catch (e) {
    problems.push({
      code: 'config.unreadable',
      message: `${file} 不是合法的 JSON，已忽略：${e instanceof Error ? e.message : String(e)}`,
    });
    return undefined;
  }
}

/** `"anthropic/claude-opus-5"` → `{ provider, model }`。没有斜杠时整串当模型名 */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const at = ref.indexOf('/');
  if (at === -1) return { provider: '', model: ref };
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}
