/**
 * 取消信号的最小结构。
 *
 * 刻意不用 `AbortSignal`：那个类型来自 DOM lib 或 @types/node，把任一个引进来
 * 都会让内核在编译期看到额外 I/O 表面。真实 AbortSignal 在结构上兼容。
 */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
