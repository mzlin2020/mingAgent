import { z } from 'zod';

/**
 * 插件自定义事件的**信封载荷**（ADR-0057）。
 *
 * ── 为什么只有两个事件类型，而不是每个插件事件一个类型 ──
 *
 * `EVENT_SPECS` 是闭集、`XmEvent` 是判别联合、`reduce()` 有穷尽性检查——插件往里加成员
 * 等于让插件改契约包。而 `durability` 又必须是**静态标注**（ADR-0008 的持久化包含性测试
 * 要在不跑真实会话的前提下把事件流拆两份）。两条约束一夹，剩下的空间就只有
 * "按持久化层级分的两个静态信封"这一种形状。
 *
 * 事件的完整标识是 `ext.<pluginId>.<name>`，但 `type` 字段只有 `ext.persisted` /
 * `ext.transient` 两个取值。消费者按 `pluginId` + `name` 二次分派——比原生事件多一层，
 * 换来的是闭集与穷尽性检查一条没破。
 */
export const ExtEventPayload = z.looseObject({
  /**
   * 写入者的身份，形如 `git`、`com-xiaoming-git`，与 `PluginManifest.id` 一致。
   *
   * **由运行时按写入者身份填，不由插件自己填。** 否则一个插件可以冒充另一个插件写事件，
   * 而事件流是审计的底稿——底稿上的署名如果可以自填，它就不再是底稿。
   */
  pluginId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** 不含 `ext.<pluginId>.` 前缀的事件名 */
  name: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/).max(64),
  /** 该插件事件的载荷版本，演进规则同 ADR-0008（由插件自己维护 upcaster） */
  version: z.number().int().positive(),
  /** 由插件注册的 Zod schema 校验；契约包本身对它零类型信息 */
  data: z.unknown(),
});
export type ExtEventPayload = z.infer<typeof ExtEventPayload>;

/** 插件事件的完整标识。只用于展示与审计，不是 `type` 字段的取值。 */
export const extEventName = (pluginId: string, name: string): string =>
  `ext.${pluginId}.${name}`;
