import type { EventOf } from '@xm/contracts';
import type { ExtEventDeclaration, ExtEventDraft } from '@xm/kernel';
import { prepareExtEvent } from '@xm/kernel';
import type { SessionRuntime } from './session-runtime.js';

/**
 * 插件的**窄写入口**（ADR-0057 §四）。
 *
 * 它不是 `record()` 的别名，也不是它的包装糖：`record()` 收的是"事件类型 + 任意 payload"，
 * 给插件那个入口，等于让插件能伪造 `tool.end` —— 而事件流是权限审计的底稿。
 * 这里收的是"事件名 + 层级 + 数据"，`pluginId` 由声明带来、`type` 由层级推出，
 * 两个字段插件都碰不到。与 ADR-0041 给 todo 工具的窄回调是同一个形状、同一个理由。
 *
 * seq 仍由 `SessionRuntime` 单点分配：插件事件与内建事件共用同一条序列，
 * 于是回放、审计、崩溃恢复自动覆盖它们，ADR-0013 不变量三不因写入者变多而放松。
 */
export interface ExtRecorder {
  readonly pluginId: string;
  record(draft: ExtEventDraft): Promise<EventOf<'ext.persisted'> | EventOf<'ext.transient'>>;
}

export const createExtRecorder = (options: {
  readonly runtime: Pick<SessionRuntime, 'record'>;
  readonly declaration: ExtEventDeclaration;
}): ExtRecorder => ({
  pluginId: options.declaration.manifest.id,
  record: async (draft) => {
    const prepared = prepareExtEvent(options.declaration, draft);
    // 分开写而不是把 type 当变量传：`record()` 的返回类型按 type 精确推导，
    // 合并成一行就只能靠断言，而断言正是这条链上最不该出现的东西。
    return prepared.type === 'ext.persisted'
      ? options.runtime.record({ type: 'ext.persisted', payload: prepared.payload })
      : options.runtime.record({ type: 'ext.transient', payload: prepared.payload });
  },
});
