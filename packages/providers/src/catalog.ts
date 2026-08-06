import type { ModelCapabilities } from '@xm/kernel';

/**
 * 模型能力表。**是数据，不是判断。**
 *
 * 端口注释写着「写死"Anthropic 支持思考"这种判断，等于把 Provider 差异漏回内核」。
 * 那句话管的是内核；到了适配器里，这些事实总得有个落点，而落点应该是一张能被配置
 * 覆盖的表，不是散落在代码里的 `if (model.startsWith('claude'))`。
 *
 * ── 不知道的一律取保守值 ──
 *
 * `maxOutput` 猜大了的后果是请求被服务端拒绝、用户看到一句晦涩的 400；
 * 猜小了的后果是回复被截断，用户看得见、也改得动（配置里调）。
 * 两种错法的可观测性差一个数量级，所以往小了取。`maxContext` 同理。
 *
 * 这张表**不参与安全判定**，猜错不会造成越权——它只影响请求参数与 UI 展示。
 */

/** 什么都不知道时的兜底。刻意保守，且 tools 为 true——否则工具会从模型视野里消失 */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = {
  tools: true,
  parallelTools: false,
  vision: false,
  documents: false,
  thinking: false,
  promptCache: false,
  maxContext: 128_000,
  maxOutput: 4_096,
};

const CLAUDE: ModelCapabilities = {
  tools: true,
  parallelTools: true,
  vision: true,
  documents: true,
  thinking: true,
  promptCache: true,
  maxContext: 200_000,
  maxOutput: 8_192,
};

/**
 * 前缀匹配的能力表。用前缀而不是全名，是因为模型 id 常带日期后缀
 * （`claude-haiku-4-5-20251001`），每出一个日期版本就要改一次代码是不可接受的。
 *
 * 匹配取**最长前缀**，这样 `claude-haiku-4-5` 能覆盖 `claude-` 的通用项。
 */
const PREFIX_CAPABILITIES: readonly (readonly [string, ModelCapabilities])[] = [
  ['claude-', CLAUDE],
  ['gpt-', { ...CONSERVATIVE_CAPABILITIES, parallelTools: true, vision: true }],
];

export function capabilitiesFor(
  model: string,
  overrides: Readonly<Record<string, Partial<ModelCapabilities>>> = {},
): ModelCapabilities {
  let best: ModelCapabilities = CONSERVATIVE_CAPABILITIES;
  let bestLength = -1;
  for (const [prefix, caps] of PREFIX_CAPABILITIES) {
    if (model.startsWith(prefix) && prefix.length > bestLength) {
      best = caps;
      bestLength = prefix.length;
    }
  }
  const override = overrides[model];
  return override === undefined ? best : { ...best, ...override };
}
