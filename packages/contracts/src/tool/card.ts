import { z } from 'zod';

/**
 * 工具卡片（ADR-0058）。
 *
 * 取代 `DisplayHint` 的"工具自报 renderer ID + 任意 payload"：卡片是一个**闭集**，
 * 只有下面四种。渲染层认识的是**卡片种类**，不是工具——这是 `docs/05`
 * "新增工具不需要改 UI 代码"能兑现的全部理由。
 *
 * ⚠️ **四种是闭集，加第五种比加工具贵得多**，需要新 ADR 并同批更新渲染层。
 * 这是有意的：卡片种类若随工具数量增长，就等于换个地方重演"每加一个工具改一处 UI"。
 * 插件能贡献的是这四种的**渲染器**，不是新种类。
 */

/** 可跳转位置。编辑器集成用它把卡片上的一行指到文件的某一行 */
export const CardLocation = z.strictObject({
  path: z.string().min(1).max(4096),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});
export type CardLocation = z.infer<typeof CardLocation>;

/**
 * 卡片上的一个可点动作（ADR-0065）。
 *
 * **这里没有工具名、没有路径、没有任何"要执行什么"的描述**——渲染层能拿到的只有
 * `actionId` 和一个"载荷从哪来"的枚举。它不知道点下去会调用什么，
 * 因此一张模型构造出来的卡片没法诱导用户点出一次任意工具调用。
 *
 * `payload` 说的是**渲染层该送什么上来**，不是送什么就一定被接受：
 * 主进程侧仍要按 `CARD_ACTION_PAYLOAD` 再校验一次（ADR-0065 步骤 ③）。
 *  - `none`：无载荷，点了就是点了（"拒绝全部"）。
 *  - `selection`：`{ selected: string[] }`，元素是**卡片自己给出的选择项 id**
 *    （diff 卡片就是 hunkId）。选择集属于卡片种类的语义，不属于某个工具——
 *    渲染层因此能在不认识任何工具的前提下把它拼出来。
 */
export const CardAction = z.strictObject({
  actionId: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64),
  label: z.string().min(1).max(64),
  payload: z.enum(['none', 'selection']),
  /** 主按钮（"应用选中"）与次按钮（"拒绝全部"）的排版差别，纯外观 */
  emphasis: z.enum(['primary', 'secondary']).default('secondary'),
});
export type CardAction = z.infer<typeof CardAction>;

/**
 * `diff` 卡片里的一个文件。两种形状，按"调用时刻知道什么"分：
 *
 *  - `full`：整文件对倒。`oldText: null` 表示新建。**只在调用参数里本来就带着全文时用**
 *    （`fs.write`）——投影函数不许读盘，所以它拿不到旧内容，新建以外的情形只能给 `null`。
 *  - `hunks`：逐块补丁。局部编辑（`edit.preview`）用这个，
 *    **不把整份文件的前后两份全文落进事件流**——ADR-0050 刚因为"整文件对倒"收窄过一次模型
 *    可见结果，展示数据走同一个方向。`hunkId` 同时是逐块接受/拒绝时的选择项 id。
 */
export const CardDiffFile = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('full'),
    path: z.string().min(1).max(4096),
    oldText: z.string().nullable(),
    newText: z.string(),
  }),
  z.strictObject({
    kind: z.literal('hunks'),
    path: z.string().min(1).max(4096),
    hunks: z.array(
      z.strictObject({
        hunkId: z.string().min(1).max(128),
        /** unified diff 文本 */
        patch: z.string(),
      }),
    ),
  }),
]);
export type CardDiffFile = z.infer<typeof CardDiffFile>;

const base = {
  /**
   * 折叠态一行摘要。**也是渲染器缺失时唯一被渲染的东西**
   * （`DisplayHint.summary` 的降级语义原样继承）。
   *
   * `min(1)` 不是洁癖：没有渲染器时整张卡片只剩这一行，空串就等于白屏——
   * 而"三方插件贡献了一个我们没有渲染器的卡片种类"正是发布前测不到的那种组合。
   * 空摘要的卡片过不了校验，于是降级成通用卡片，而通用卡片的摘要恒非空。
   */
  summary: z.string().min(1).max(400),
  actions: z.array(CardAction).max(8).optional(),
};

export const ToolCard = z.discriminatedUnion('kind', [
  /** 默认卡片。标题 + 可选正文 + 可跳转位置 */
  z.strictObject({
    ...base,
    kind: z.literal('generic'),
    title: z.string().min(1).max(200),
    body: z.string().max(64 * 1024).optional(),
    locations: z.array(CardLocation).max(200).optional(),
  }),
  /** 这次调用就是一条命令 */
  z.strictObject({
    ...base,
    kind: z.literal('terminal'),
    command: z.string().max(8192),
    cwd: z.string().max(4096).optional(),
    output: z.string().max(256 * 1024).optional(),
    exitCode: z.number().int().optional(),
  }),
  /** 这次调用会创建或修改文件 */
  z.strictObject({
    ...base,
    kind: z.literal('diff'),
    files: z.array(CardDiffFile).max(100),
  }),
  /**
   * 发现类结果：按文件分组的匹配，或一个扁平路径列表。
   *
   * 只有结果卡片、没有调用卡片——匹配只在 `execute` 之后才存在，调用态老实显示通用卡片就好。
   * 这条看着琐碎，但它是"卡片必须是它已知信息的诚实投影"的一个具体落点。
   */
  z.strictObject({
    ...base,
    kind: z.literal('search'),
    query: z.string().max(1024).optional(),
    groups: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(4096),
          matches: z
            .array(z.strictObject({ line: z.number().int().positive().optional(), text: z.string().max(4096) }))
            .max(200),
        }),
      )
      .max(200)
      .optional(),
    /** 扁平路径列表（`fs.list`、按文件名检索） */
    paths: z.array(z.string().max(4096)).max(1000).optional(),
    truncated: z.boolean().default(false),
    total: z.number().int().nonnegative().optional(),
  }),
]);
export type ToolCard = z.infer<typeof ToolCard>;
export type ToolCardKind = ToolCard['kind'];

/** 一次调用的两张卡片：挂起态与完成态。两张都可能缺席（工具没有投影，或投影降级） */
export const ToolCardPair = z.strictObject({
  call: ToolCard.optional(),
  result: ToolCard.optional(),
});
export type ToolCardPair = z.infer<typeof ToolCardPair>;

/**
 * 动作载荷的**闭集**。
 *
 * ADR-0065 写的是"工具声明 `schema`"，落地时收紧成"工具声明 `payload` 种类、种类决定
 * schema"：`CardAction.payload` 只有两个取值，主进程侧就按这张表校验。
 * 这比让每个工具自带一份 schema **更紧**——没有任何工具能把自己的载荷放宽成任意形状，
 * 而"未声明的 actionId 拒绝 + 载荷必须过校验"两条一个不少。
 *
 * `selected` 的元素是**卡片自己给出的选择项 id**（diff 卡片即 `hunkId`）。
 * 它是否属于这张卡片，由工具在 `prepare` 里对着自己的事实再核一遍——
 * 渲染层送上来的东西一律不可信。
 */
export const CARD_ACTION_PAYLOAD = {
  none: z.strictObject({}),
  selection: z.strictObject({
    selected: z.array(z.string().min(1).max(128)).max(2000),
  }),
} as const;

export type CardActionPayloadKind = keyof typeof CARD_ACTION_PAYLOAD;
export type CardActionPayload = {
  [K in CardActionPayloadKind]: z.infer<(typeof CARD_ACTION_PAYLOAD)[K]>;
}[CardActionPayloadKind];
