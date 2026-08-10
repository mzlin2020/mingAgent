/**
 * 正文栏。Home 与对话共用同一个宽度与同一套水平内边距。
 *
 * 上一版 Home 是 `max-w-2xl`、对话是 `max-w-3xl`，在两者之间来回切时内容栏会**变宽再变窄**——
 * 那种说不出哪里不对、但一直觉得界面不稳的感觉，一半来自这里。顶栏、消息栏、输入框的左缘
 * 现在也落在同一条竖线上。
 *
 * 放在 `lib/` 而不是 `App.tsx`：`HomeView` / `Composer` 都要用，从 `App.tsx` 导出会形成
 * 装配层与组件的循环依赖。
 */
export const COLUMN = 'mx-auto w-full max-w-3xl px-6';
