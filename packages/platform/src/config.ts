import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Config,
  ConfigPatch,
  PolicyRuleSet as PolicyRuleSetType,
  ProviderConfig,
} from '@xm/contracts';
import {
  Config as ConfigSchema,
  PolicyRuleSet,
  findPlaintextSecrets,
  mergeConfigLayers,
} from '@xm/contracts';
import type { XmPaths } from '@xm/kernel';
import { tightenOnly } from '@xm/kernel';

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
  /**
   * 合并后的配置。
   *
   * ⚠️ `permission.rules` 在这里**恒为空数组**——权限规则不走合并，走分层
   * （ADR-0023），真正的内容在 `permissionRules` 里。留一份合并后的副本等于留两份
   * 真相，而这一份恰好是错的：数组的合并语义是整体替换，于是项目级的规则会把
   * 用户级的**整个抹掉**，那与"后一层覆盖前一层"完全不是一回事。
   */
  readonly config: Config;
  /**
   * 按层分开的权限规则。项目层已经过 `tightenOnly()`——
   * 被丢掉的条目在 `problems` 里有一条对应的记录。
   */
  readonly permissionRules: {
    readonly user: PolicyRuleSetType;
    readonly project: PolicyRuleSetType;
  };
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
  readonly code:
    | 'config.unreadable'
    | 'config.invalid'
    | 'config.plaintext_secret'
    | 'config.rules_invalid'
    | 'config.project_rules_dropped';
  readonly message: string;
}

/** 内置默认。是这棵树里唯一不需要文件就能拿到的一层 */
export const DEFAULT_CONFIG: ConfigPatch = {
  model: { main: 'anthropic/claude-opus-5' },
  providers: {},
  prices: {},
  permission: { rules: [] },
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
  const raw: (ConfigPatch | undefined)[] = [];

  for (const file of files) {
    const layer = await readLayer(file, problems);
    sources.push({ file, loaded: layer !== undefined });
    raw.push(layer);
    if (layer !== undefined) layers.push(layer);
  }

  const permissionRules = {
    user: rulesOf(raw[0], files[0] ?? '', problems),
    project: projectRules(rulesOf(raw[1], files[1] ?? '', problems), files[1] ?? '', problems),
  };

  const merged = mergeConfigLayers(...layers, { permission: { rules: [] } });

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
  if (parsed.success) return { config: parsed.data, permissionRules, sources, problems };

  problems.push({
    code: 'config.invalid',
    message: `配置不合法，已退回内置默认：${parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')} ${i.message}`)
      .join('；')}`,
  });

  /*
   * 内置默认必须永远能过校验。过不了是我们自己的 bug，那时抛是对的。
   *
   * 权限规则**一并退回空**：配置整体不合法时，继续用从里面抠出来的那几条规则，
   * 等于在一份我们已经判定读不懂的文件上做安全判定。
   */
  return {
    config: ConfigSchema.parse(DEFAULT_CONFIG),
    permissionRules: { user: [], project: [] },
    sources,
    problems,
  };
}

export interface PersistProviderConfigOptions {
  readonly paths: XmPaths;
  readonly providerId: string;
  readonly provider: ProviderConfig;
}

/**
 * 用户主动录入密钥后，把对应 Provider 的 SecretRef 原子写回用户配置。
 * 只允许不存在的文件从空对象开始；损坏或无权限的配置绝不覆盖。
 */
export async function persistProviderConfig(options: PersistProviderConfigOptions): Promise<void> {
  const file = join(options.paths.config, 'config.json');
  const current = await readJsonForUpdate(file);
  const providers = isRecord(current.providers) ? current.providers : {};
  const merged = {
    ...current,
    providers: { ...providers, [options.providerId]: options.provider },
  };
  await writeJsonAtomic(file, merged);
}

async function readJsonForUpdate(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) throw new Error(`${file} 的顶层不是对象，拒绝覆盖。`);
    return parsed;
  } catch (e) {
    if (isNotFound(e)) return {};
    throw new Error(
      `无法安全更新 ${file}：现有配置读不到或不是合法 JSON，已保留原文件。${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.xm-config-${String(process.pid)}-${String(Date.now())}.tmp`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 从一层原始配置里取出权限规则并校验。
 *
 * **单独校验、单独失败**：一条写坏的规则不该让整份配置退回默认（那会连模型配置一起丢），
 * 但它也绝不能被当成"没写"而静默跳过——安全规则失效的沉默代价太大。
 * 所以这里的做法是：整层丢弃 + 一条说清是哪个文件的 problem。
 */
function rulesOf(
  layer: ConfigPatch | undefined,
  file: string,
  problems: ConfigProblem[],
): PolicyRuleSetType {
  const rules: unknown = (layer?.permission as { rules?: unknown } | undefined)?.rules;
  if (rules === undefined) return [];

  const parsed = PolicyRuleSet.safeParse(rules);
  if (parsed.success) return parsed.data;

  problems.push({
    code: 'config.rules_invalid',
    message:
      `${file} 里的 permission.rules 不合法，**整层权限规则已忽略**：` +
      parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('；'),
  });
  return [];
}

/**
 * 项目层**只能收紧**（ADR-0023）。
 *
 * `.xiaoming/config.json` 的作者不是用户——它躺在 clone 下来的仓库里，而小明自己
 * 有 `fs.write`，模型完全可以在干活的过程中把它写出来。层序里项目层排在用户层之后，
 * 它要是能放松，就等于"仓库里的一个文件可以撤销用户的设置"。
 */
function projectRules(
  rules: PolicyRuleSetType,
  file: string,
  problems: ConfigProblem[],
): PolicyRuleSetType {
  const { rules: kept, dropped } = tightenOnly(rules);
  if (dropped.length > 0) {
    problems.push({
      code: 'config.project_rules_dropped',
      message:
        `${file} 是项目级配置，其中 ${String(dropped.length)} 条放松权限的规则已被忽略` +
        `（${dropped.join('、')}）。项目配置只能收紧权限——它随仓库分发，作者不一定是你。` +
        `确实需要放宽，请写在用户级配置里。`,
    });
  }
  return kept;
}

async function readLayer(file: string, problems: ConfigProblem[]): Promise<ConfigPatch | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return undefined;
    problems.push({
      code: 'config.unreadable',
      message: `${file} 无法读取，已忽略：${e instanceof Error ? e.message : String(e)}`,
    });
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

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

/** `"anthropic/claude-opus-5"` → `{ provider, model }`。没有斜杠时整串当模型名 */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const at = ref.indexOf('/');
  if (at === -1) return { provider: '', model: ref };
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}
