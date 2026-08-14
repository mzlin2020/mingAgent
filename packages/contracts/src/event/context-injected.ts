import { z } from 'zod';
import { AgentId, CallId } from '../base/ids.js';
import { ResultBlock } from '../content/block.js';
import { Capability } from '../permission/capability.js';

export const ContextInjectionSource = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('plugin'), pluginId: z.string().min(1) }),
  z.looseObject({ kind: z.literal('subagent'), agentId: AgentId }),
  z.looseObject({ kind: z.literal('job'), jobId: z.string().min(1) }),
  z.looseObject({ kind: z.literal('cron'), cronId: z.string().min(1) }),
  z.looseObject({ kind: z.literal('watcher'), watcherId: z.string().min(1) }),
]);
export type ContextInjectionSource = z.infer<typeof ContextInjectionSource>;

/** 模型可见的异步注入必须与普通消息走同一条持久时间线（ADR-0056/0064）。 */
export const ContextInjectedPayload = z.looseObject({
  content: z.array(ResultBlock),
  source: ContextInjectionSource,
  /** 外部内容的粘性污点；缺省表示来源没有引入不可信内容。 */
  untrustedContext: z
    .looseObject({
      callId: CallId,
      toolName: z.string(),
      viaCapability: Capability,
      since: z.number().int(),
    })
    .optional(),
});
