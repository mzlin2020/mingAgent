import { z } from 'zod';

/**
 * 一条搜索命中。**两条搜索实现（ripgrep 与纯 Node 退路）共用它**。
 *
 * ── 为什么它现在是结构，以前是一个拼好的字符串 ──
 *
 * 两条实现过去都直接 `push(\`${path}:${line}:${col}: ${text}\`)`，位置信息在离开
 * 搜索函数的那一刻就变成了散文。ADR-0071 要求工具交给程序一份规范值，而
 * "从 `src/a.ts:12:5: const x = 1` 里把行号切出来"是一件**看起来能做、实际会错**的事：
 * Windows 上的绝对路径自带冒号，正文里也可以有冒号。
 *
 * 所以结构是源头，字符串由 `formatHit()` 现拼——模型看到的那一行一个字符没变，
 * 但它不再是唯一的那份事实。
 */
export const SearchHit = z.strictObject({
  /** 相对 cwd 的位置（拼不出相对路径时是绝对路径），一律 `/` 分隔 */
  path: z.string(),
  /** 1 起算 */
  line: z.number().int(),
  /**
   * 1 起算的**字符**列号（不是字节偏移）。
   *
   * 上下文行没有"命中位置"可言，一律 0——这是原来那两处实现就有的约定，
   * 写进 schema 只是让它不再需要口口相传。
   */
  column: z.number().int(),
  /** 该行文本，换行已折成 `↵` */
  text: z.string(),
  /** 这条是 `context` 参数带出来的上下文行，不是命中本身 */
  context: z.boolean(),
});
export type SearchHit = z.infer<typeof SearchHit>;

/** 模型可见的那一行。两条实现共用，保证格式不会在某一条路径上悄悄漂移 */
export const formatHit = (hit: SearchHit): string =>
  `${hit.path}:${String(hit.line)}:${String(hit.column)}: ${hit.text}`;
