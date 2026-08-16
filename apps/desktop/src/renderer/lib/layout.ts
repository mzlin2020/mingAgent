/**
 * 共享宽度轴（M3.5-c，总纲 §6.2）。
 *
 * 上一版是 Tailwind 类名常量 `COLUMN = 'mx-auto w-full max-w-3xl px-6'`。
 * Home 与对话共用同一个 max-width，切来切去栏宽不会跳——那一条保留。
 * 换掉的是**承载方式**：三个组件专用变量（`--xm-*`，不进 `@theme`）替掉那串类名，
 * 这样「正文 W、输入卡 W+32、两侧 clearance+16」是一处声明，不是两处各写各的 max-width。
 *
 * 数字写在这个文件里，CSS 里再抄一遍同值。`layout.test.ts` 读 CSS 钉死它们没漂。
 */

/** 正文列宽 W */
export const CHAT_CONTENT_WIDTH_PX = 720;
/** 输入卡比正文宽这么多，所以两侧各探出 gutter 那么多 */
export const COMPOSER_EXTRA_PX = 32;
/** 正文在 clearance 之外再留的那一圈 */
export const CHAT_GUTTER_PX = 16;
/** sticky 输入区上方的渐变遮罩。必须是像素：百分比会跟着输入框长高一起拉长 */
export const COMPOSER_FADE_PX = 36;
/** 工具行收起态高度 */
export const TOOL_ROW_HEIGHT_PX = 24;
/** 运行中扫光带宽度 */
export const TOOL_ROW_GLARE_PX = 300;
/** 回到底部圆钮边长；槽高为 0，靠负 margin 把钮拉上去，不撑高 scrollHeight */
export const TO_BOTTOM_SIZE_PX = 34;
/** 发送键旁上下文占用环 */
export const CONTEXT_METER_SIZE_PX = 14;

export const CHAT_AXIS = 'chat-axis';
export const CHAT_BODY = 'chat-axis__body';

/** Home / 设置这种没有输入卡的页：轴 + 正文两侧 padding */
export const CHAT_COLUMN = `${CHAT_AXIS} ${CHAT_BODY}`;

export interface ConversationHeroInput {
  readonly messageCount: number;
  readonly hasLiveMessage: boolean;
  readonly running: boolean;
  readonly busy: boolean;
  readonly pendingCount: number;
}

/**
 * 会话空态：输入卡居中。Home 是另一回事（最近会话列表），两者不能再并成一个视图。
 *
 * 发出第一条（消息进流、在途、回合开始、排队）就立刻 dock，不要等第一轮回复结束。
 */
export function isConversationHero(input: ConversationHeroInput): boolean {
  return (
    input.messageCount === 0 &&
    !input.hasLiveMessage &&
    !input.running &&
    !input.busy &&
    input.pendingCount === 0
  );
}

/** 空态副标题只取最后一段目录名；完整路径放 title。 */
export function workspaceLabel(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined;
  const parts = cwd.split(/[/\\]/).filter((part) => part !== '');
  return parts.at(-1) ?? cwd;
}
