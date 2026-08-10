/**
 * Home「最近会话」的相对时间。
 *
 * ADR-0037 把「Home 无 cwd，同名会话难辨」记成了一条负面，并写明缓解手段是
 * 「可后续加相对时间或 cwd」。这里落的是前者：列表头上写着"按最近活动排序"，
 * 有了这一列，那句话才是可核对的，而不是一句用户只能选择相信的话。
 *
 * ── `now` 为什么是参数而不是在函数里取 ──
 *
 * 取当前时间的函数没法在测试里断言边界（59 秒 / 60 秒 / 昨天 23:59）。传进来之后
 * 这就是一个纯函数，测试直接钉死两个时间戳即可，不用假造计时器。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 两个时刻相隔几个"自然日"（不是几个 24 小时）——23:50 到次日 00:10 是 1 天 */
function calendarDaysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / DAY);
}

export function formatRelativeTime(at: number, now: number): string {
  const elapsed = now - at;

  // 时钟回拨或本机与事件源有偏差时 elapsed 会是负的。显示"1 分钟后"没有意义，归到"刚刚"
  if (elapsed < MINUTE) return '刚刚';
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))} 分钟前`;

  // 24 小时内一律按小时说。跨了午夜也不说"昨天"——凌晨 0:30 看 3 小时前的会话，
  // "昨天"比"3 小时前"更容易让人以为那是很久之前的事
  if (elapsed < DAY) return `${String(Math.floor(elapsed / HOUR))} 小时前`;

  const then = new Date(at);
  const today = new Date(now);
  const days = calendarDaysBetween(then, today);
  if (days <= 1) return '昨天';
  if (days < 7) return `${String(days)} 天前`;

  const md = `${String(then.getMonth() + 1)}月${String(then.getDate())}日`;
  return then.getFullYear() === today.getFullYear() ? md : `${String(then.getFullYear())}年${md}`;
}
