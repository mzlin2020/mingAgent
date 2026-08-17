import { normalizedOrThrow } from '../policy/target.js';

/**
 * 平台端口（ADR-0007 保险 1）。
 *
 * 平台差异**全部**收敛到这个接口之后：路径、密钥后端、屏幕、输入注入、托盘、通知。
 * 业务代码里禁止出现 `process.platform`（ESLint `no-restricted-properties` 强制），
 * 加一个平台等于实现一个适配器，而不是在全代码库里考古。
 *
 * 端口定在内核，是因为内核确有两个真实消费者：
 *   · `paths()` 是 `builtinRules()` 的输入——红线要保护的是运行时真实存在的那些路径
 *   · `capabilities()` 是工具 `available?()` 的输入——Linux 上没有输入注入，
 *     对应工具就该从模型视野里消失，而不是调用后报错
 *
 * 内核零 I/O，所以这里只有类型；探测与解析在 `@xm/platform`。
 * 二进制一律 `Uint8Array`：`tsconfig.base.json` 的 `types: []` 让 `Buffer` 在内核里
 * 根本不存在，这不是风格问题，是"内核能在浏览器里跑"的编译期保证。
 */

export type OsFamily = 'macos' | 'windows' | 'linux';

/**
 * 密钥后端 —— **三态，不是 boolean**。
 *
 * ADR-0007 保险 2 要求"退化时明确告知用户而非静默降级"，而 boolean 表达不出
 * `plaintext-unavailable` 这个必须让用户看见的中间态：Linux 无桌面会话、容器、CI 里
 * `safeStorage` 会退化成明文，那时正确的行为是**拒绝存密钥并告诉用户为什么**，
 * 不是假装存上了。用 boolean 写这个接口，退化就只能靠 `false` 表达，
 * 而 `false` 会被读成"没有密钥功能"，于是没人去写那条提示。
 */
export type SecretBackend =
  /** OS 钥匙串：macOS Keychain / Windows Credential Manager / libsecret */
  | 'keychain'
  /** 无钥匙串，但可用用户口令加密的文件兜底（需要用户设置口令） */
  | 'encrypted-file'
  /** 两者都不可用。**必须拒绝存储密钥**，不允许退化成明文 */
  | 'plaintext-unavailable';

export interface PlatformCapabilities {
  readonly secrets: SecretBackend;
  /** 当前执行环境能否创建 node-pty/ConPTY 终端。 */
  readonly shellSession: boolean;
  readonly screenCapture: boolean;
  /** Wayland 上多半是 false（ADR-0007 Tier 3：可能长期缺失） */
  readonly inputInjection: boolean;
  readonly tray: boolean;
  readonly notifications: boolean;
}

/**
 * 小明用到的全部目录。**绝对路径，且已规范化**。
 *
 * `home` 与 `sourceRoot` 直接喂给 `builtinRules()`——两者必须与 `data` 出自同一次解析，
 * 否则就会重演 ADR-0012 ①：红线里写的是一个坐标系的路径，请求里传的是另一个坐标系的。
 */
export interface XmPaths {
  readonly home: string;
  /**
   * 小明**源码树**的根（有 `packages/` 与 `apps/` 的那一棵），由平台层从入口位置
   * 向上找标记文件推导。找不到就等于入口目录本身——那时真正起作用的是 `installRoot`。
   *
   * 这个字段以前叫 `appRoot`，含义在"仓库"与"安装目录"之间摇摆，于是桌面端喂了
   * `app.getAppPath()`，整族自改红线锚在一个不存在的目录上（ADR-0078）。
   */
  readonly sourceRoot: string;
  /**
   * 打包安装目录。**只有打包运行时才有**（开发时跑的是源码树，没有这个概念）。
   * 整棵树禁写禁删：asar 里没有源码，能改的只有可执行文件、原生模块与 asar 本身。
   */
  readonly installRoot?: string;
  /** 事件库、审计库、blob 都在这下面 */
  readonly data: string;
  readonly config: string;
  readonly cache: string;
  readonly logs: string;
}

export interface PlatformPort {
  readonly os: OsFamily;
  paths(): XmPaths;
  capabilities(): PlatformCapabilities;
}

// ── 数据目录布局 ────────────────────────────────────────────────

/**
 * 数据目录下的固定文件名。
 *
 * 单独抽出来是为了让**红线规则**与**存储适配器**用同一份定义：
 * 一边写 `audit.db`、另一边打开 `audit.sqlite`，红线就会安静地保护一个不存在的文件，
 * 而 depcruise、lint、类型检查全都发现不了。这类失效在 M0-a 复审里出现过三次。
 */
export const XM_DATA_FILES = {
  events: 'events.db',
  audit: 'audit.db',
  blobs: 'blobs',
} as const;

export interface XmDataLayout {
  readonly dataDir: string;
  readonly eventsDb: string;
  readonly auditDb: string;
  readonly blobsDir: string;
}

/**
 * 从数据目录推出全部落盘位置。**规范化失败直接抛**——
 * 构造期出错好过运行期失效（同 `normalizedOrThrow` 的取舍）。
 */
export function xmDataLayout(dataDir: string): XmDataLayout {
  const base = normalizedOrThrow(dataDir);
  return {
    dataDir: base,
    eventsDb: `${base}/${XM_DATA_FILES.events}`,
    auditDb: `${base}/${XM_DATA_FILES.audit}`,
    blobsDir: `${base}/${XM_DATA_FILES.blobs}`,
  };
}
