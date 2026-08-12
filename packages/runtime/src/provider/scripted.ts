import type { ModelChunk, ModelRequest } from '@xm/contracts';
import type { AbortLike, ModelCapabilities, ModelInfo, ModelProvider } from '@xm/kernel';

/**
 * 按剧本吐 chunk 的 Provider。
 *
 * 放在 `src/` 而不是 `tests/`，理由与 `EVENT_STORE_CONTRACT` 完全相同：
 * headless 冒烟、`apps/desktop` 的空跑、以及将来的评测回放都要 import 它，
 * 而跨包 import 一个 `.test.ts` 走不通。
 *
 * 它不是"假 Provider"这么简单——它是**回归测试的输入源**。M1 接上真实 Anthropic
 * 之后，这个 Provider 仍然是唯一能让"同样的模型输出跑出同样的事件流"这件事成立的东西，
 * 而那正是 docs/07 评测集与 M5 回放能力的前提。
 */

export interface ScriptedTurn {
  /** 这一轮要吐的 chunk，顺序即时序 */
  readonly chunks: readonly ModelChunk[];
}

export interface ScriptedProviderOptions {
  readonly id?: string;
  readonly turns: readonly ScriptedTurn[];
  readonly capabilities?: Partial<ModelCapabilities>;
  /** 每个 chunk 之间的延迟（ms）。默认 0；给取消测试用 */
  readonly chunkDelayMs?: number;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  parallelTools: false,
  vision: false,
  documents: false,
  thinking: true,
  promptCache: false,
  maxContext: 200_000,
  maxOutput: 8_192,
};

export class ScriptedProvider implements ModelProvider {
  readonly id: string;
  readonly #turns: readonly ScriptedTurn[];
  readonly #capabilities: ModelCapabilities;
  readonly #delay: number;
  #cursor = 0;
  readonly requests: ModelRequest[] = [];

  constructor(options: ScriptedProviderOptions) {
    this.id = options.id ?? 'scripted';
    this.#turns = options.turns;
    this.#capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.#delay = options.chunkDelayMs ?? 0;
  }

  /** 已经消费掉几轮。剧本没跑完就结束测试，多半是断言写漏了 */
  get consumedTurns(): number {
    return this.#cursor;
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve([
      { id: 'scripted-1', displayName: '剧本模型', capabilities: this.#capabilities },
    ]);
  }

  capabilities(): ModelCapabilities {
    return this.#capabilities;
  }

  async *stream(req: ModelRequest, signal: AbortLike): AsyncIterable<ModelChunk> {
    this.requests.push(req);
    const turn = this.#turns[this.#cursor];
    if (turn === undefined) {
      throw new Error(
        `剧本只有 ${String(this.#turns.length)} 轮，但被请求了第 ${String(this.#cursor + 1)} 轮。` +
          `多半是循环没有在预期的地方停下——那本身就是要查的事。`,
      );
    }
    this.#cursor += 1;

    for (const chunk of turn.chunks) {
      if (signal.aborted) return;
      if (this.#delay > 0) await sleep(this.#delay);
      yield chunk;
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
