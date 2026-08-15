import type { Durability, ExtEventPayload, PluginManifest } from '@xm/contracts';
import { extEventName } from '@xm/contracts';
import type { z } from 'zod';

/**
 * 插件事件的写入闸门（ADR-0057 §二）——**纯逻辑，不碰事件流**。
 *
 * 放在内核而不是运行时，是因为这里全是判断：清单查表、信封匹配、载荷校验。
 * 运行时那一侧只剩"把判断结果交给 `record()`"，那部分没什么可测的，
 * 而这部分每一条都是失败关闭的分支，值得单独打。
 */

export type ExtEventRejection =
  | 'undeclared'
  | 'durability-mismatch'
  | 'no-schema'
  | 'invalid-data'
  | 'invalid-name';

export class ExtEventRejected extends Error {
  override readonly name = 'ExtEventRejected';
  readonly reason: ExtEventRejection;
  readonly pluginId: string;
  readonly eventName: string;

  constructor(reason: ExtEventRejection, pluginId: string, eventName: string, detail: string) {
    super(`插件事件 ${extEventName(pluginId, eventName)} 被拒绝：${detail}`);
    this.reason = reason;
    this.pluginId = pluginId;
    this.eventName = eventName;
  }
}

/**
 * 一个插件的事件声明。
 *
 * `manifest` 由**插件宿主**在加载时提供，不是插件运行时递上来的对象——`pluginId`
 * 的可信度全押在这一点上。宿主还没落地（M4），所以现在由装配方直接传入；
 * 那一天到来时，改的是"谁构造这个声明"，不是这里的判断。
 */
export interface ExtEventDeclaration {
  readonly manifest: Pick<PluginManifest, 'id' | 'events'>;
  /** 事件名 → 载荷 schema。清单声明了持久化层级，schema 声明形状，缺一不可。 */
  readonly schemas: Readonly<Record<string, z.ZodType>>;
}

/**
 * 插件递上来的东西。**没有 `pluginId` 字段，也没有 `type` 字段**——
 * 冒充别的插件、伪造 `tool.end`，在接口上就做不到，不靠运行时检查。
 */
export interface ExtEventDraft {
  readonly name: string;
  readonly durability: Durability;
  /** 该插件事件的载荷版本，默认 1 */
  readonly version?: number;
  readonly data: unknown;
}

export interface PreparedExtEvent {
  readonly type: 'ext.persisted' | 'ext.transient';
  readonly payload: ExtEventPayload;
}

const NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/**
 * 四步失败关闭，顺序与 ADR-0057 §二 一致。
 *
 * 每一步的默认答案都是"拒绝"而不是"猜一个"：不知道这条事件该不该持久，
 * 就不能替它决定——与网关"声明了路径能力却没声明 `pathInputs` 就当场失败关闭"
 * 是同一个形状、同一个理由。
 */
export const prepareExtEvent = (
  declaration: ExtEventDeclaration,
  draft: ExtEventDraft,
): PreparedExtEvent => {
  const pluginId = declaration.manifest.id;
  const { name } = draft;

  if (!NAME.test(name) || name.length > 64) {
    throw new ExtEventRejected('invalid-name', pluginId, name, '事件名不合法。');
  }

  const declared: Durability | undefined = declaration.manifest.events[name];
  if (declared === undefined) {
    throw new ExtEventRejected(
      'undeclared',
      pluginId,
      name,
      '清单里没有声明这个事件。声明之后才能写，不静默丢弃也不猜一个持久化层级。',
    );
  }
  if (declared !== draft.durability) {
    throw new ExtEventRejected(
      'durability-mismatch',
      pluginId,
      name,
      `清单声明为 ${declared}，却要写进 ext.${draft.durability} 信封。`,
    );
  }

  const schema = declaration.schemas[name];
  if (schema === undefined) {
    throw new ExtEventRejected(
      'no-schema',
      pluginId,
      name,
      '没有注册载荷 schema。契约单一来源那条不变量不因为写入者是插件就放松。',
    );
  }

  const parsed = schema.safeParse(draft.data);
  if (!parsed.success) {
    throw new ExtEventRejected('invalid-data', pluginId, name, parsed.error.message);
  }

  return {
    type: draft.durability === 'persisted' ? 'ext.persisted' : 'ext.transient',
    payload: {
      // 身份来自声明，不来自 draft——`draft` 上根本没有这个字段
      pluginId,
      name,
      version: draft.version ?? 1,
      data: parsed.data,
    },
  };
};
