/**
 * 行级 unified diff（ADR-0050）。
 *
 * ── 为什么自己写而不是加依赖 ──
 *
 * 需要的只有"行级 LCS + 带上下文的 hunk 切分"，且它必须是**确定性**的：同一对
 * before/after 在三平台、任何 Node 版本上都要产出逐字节相同的文本，因为这段文本
 * 会进持久事件、进 diff 审阅 UI，并与内容哈希一起构成 `edit.apply` 的前置条件。
 * 一个几十行的确定性实现比引入一个自带启发式（patience/histogram 可选、空白折叠
 * 可选）的依赖更容易保证这件事。
 *
 * ── 为什么 M2-d 原来的实现不行 ──
 *
 * 原来的 `unifiedDiff()` 输出的是"整文件对倒"：一个 `@@ -1,N +1,M @@` 头，后面跟
 * 全部旧行（`-`）再跟全部新行（`+`）。它形式上像 diff，实际体积随**文件大小**而不是
 * **改动量**增长。实测两个 20KB 文件、3 处单行替换 → 提案 JSON 223KB，被默认 64KB
 * middle 截断挖掉中段后，第二个文件的 beforeHash 丢失，`edit.apply` 再也拼不出来。
 * 同一根因让 diff 审阅面板的前 400 行全是删除行。
 *
 * ── 算法与它的两道闸 ──
 *
 * 先剪掉公共前后缀，再对中间段跑 Myers 的 O(ND) 贪心算法。两者都是为了让代价跟着
 * 改动量走：改一行的 10000 行文件，剪完前后缀基本就没剩什么了。
 *
 * Myers 的回溯需要保存每一步的 V 窗口，空间是 O(D²)。所以设了 `MAX_EDIT_DISTANCE`：
 * 超过它就**不假装**还能算出最小编辑脚本，而是把中间段整体作为一个替换 hunk 输出。
 * 这条退路会让那次 diff 变大，但它是显式的、有界的，且仍然是合法 unified diff——
 * 比无声地吃掉几百 MB 内存好。
 */

/** 上下文行数。3 是 `diff -u` / git 的默认值，也是人读 diff 时的习惯。 */
const DEFAULT_CONTEXT = 3;

/**
 * 允许的最大编辑距离。超过就退化成"整段替换"。
 *
 * 1200 是按真实场景定的：一次 `edit.preview` 最多 100 条替换，每条改动通常在个位数行。
 * 真正撞上这条线的是"整文件重排"式的改动，而那种改动本来也不适合逐块审阅。
 */
const MAX_EDIT_DISTANCE = 1200;

/**
 * 末尾无换行的标记，附在该侧**最后一行的比较键**上。
 *
 * 必须参与比较，不能只在输出时补一行：`"a"` 与 `"a\n"` 按 `\n` 切完都是 `["a"]`，
 * 不带标记的话 diff 会说两者相同，而内容哈希会（正确地）说不同——两边打架时出问题的是
 * `edit.apply` 的前置校验。这条是本模块的测试当场抓出来的，不是设想的风险。
 *
 * 前缀用 NUL 是为了不与真实源码行碰撞：走到这里的内容都已通过 `fatal: true` 的 UTF-8
 * 解码，NUL 合法但在源文件里实际不出现。万一真碰撞，后果也只是多标一行提示，
 * 不影响 hunk 内容与行号。
 */
const NO_NEWLINE_KEY = '\u0000no-newline-at-eof';
const NO_NEWLINE_LINE = '\\ No newline at end of file';

export interface DiffOptions {
  readonly context?: number;
}

type OpKind = '=' | '-' | '+';
interface Op {
  readonly kind: OpKind;
  readonly text: string;
}
interface Entry extends Op {
  /** 1 起算的旧行号；插入行没有旧行号 */
  readonly oldNo: number | undefined;
  readonly newNo: number | undefined;
}

/**
 * 生成标准 unified diff。两侧内容相同时返回空串。
 *
 * `path` 同时用作 `--- a/` 与 `+++ b/` 的路径：这里比较的永远是同一个文件的前后两个
 * 版本，不存在重命名。反斜杠统一成正斜杠，让三平台产出同一份文本。
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  options: DiffOptions = {},
): string {
  if (before === after) return '';
  const context = Math.max(0, options.context ?? DEFAULT_CONTEXT);
  const entries = numbered(diffOps(splitLines(before), splitLines(after)));
  const hunks = groupHunks(entries, context);
  if (hunks.length === 0) return '';

  const name = path.replaceAll('\\', '/');
  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (const hunk of hunks) {
    out.push(header(hunk, entries));
    for (const index of hunk) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const lacksNewline = entry.text.endsWith(NO_NEWLINE_KEY);
      const text = lacksNewline ? entry.text.slice(0, -NO_NEWLINE_KEY.length) : entry.text;
      out.push(`${entry.kind === '=' ? ' ' : entry.kind}${text}`);
      if (lacksNewline) out.push(NO_NEWLINE_LINE);
    }
  }
  return out.join('\n');
}

/**
 * 按行切分成比较键。末尾没有换行时给最后一行打上 `NO_NEWLINE_KEY`。
 *
 * `\r` 刻意留在行尾：CRLF 文件的 diff 应该如实显示 `\r`，而不是被悄悄规范化成 LF。
 */
function splitLines(text: string): readonly string[] {
  if (text === '') return [];
  if (text.endsWith('\n')) {
    const lines = text.split('\n');
    lines.pop();
    return lines;
  }
  const lines = text.split('\n');
  const last = lines.pop();
  return [...lines, `${last ?? ''}${NO_NEWLINE_KEY}`];
}

function diffOps(oldLines: readonly string[], newLines: readonly string[]): readonly Op[] {
  // 公共前后缀不进 Myers：改一行的大文件，剪完基本就没剩什么了
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const oldMiddle = oldLines.slice(head, oldLines.length - tail);
  const newMiddle = newLines.slice(head, newLines.length - tail);
  const middle = myers(oldMiddle, newMiddle) ?? wholeReplacement(oldMiddle, newMiddle);

  return [
    ...oldLines.slice(0, head).map((text): Op => ({ kind: '=', text })),
    ...middle,
    ...oldLines.slice(oldLines.length - tail).map((text): Op => ({ kind: '=', text })),
  ];
}

/** 超过 `MAX_EDIT_DISTANCE` 时的显式退路：整段删除 + 整段插入。 */
function wholeReplacement(oldMiddle: readonly string[], newMiddle: readonly string[]): readonly Op[] {
  return [
    ...oldMiddle.map((text): Op => ({ kind: '-', text })),
    ...newMiddle.map((text): Op => ({ kind: '+', text })),
  ];
}

/**
 * Myers O(ND) 贪心算法。编辑距离超过上限时返回 undefined，由调用方走退路。
 *
 * `trace[d]` 存的是**进入第 d 步之前**的 V 窗口（半宽 d），回溯时据此还原每一步。
 * 只存 `2d+1` 个格子而不是整条 V：整条 V 的长度是 n+m，大文件上乘以 D 会直接吃掉几百 MB。
 */
function myers(oldLines: readonly string[], newLines: readonly string[]): readonly Op[] | undefined {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max && d <= MAX_EDIT_DISTANCE; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, oldLines, newLines, d);
    }
  }
  return undefined;
}

function backtrack(
  trace: readonly Int32Array[],
  oldLines: readonly string[],
  newLines: readonly string[],
  distance: number,
): readonly Op[] {
  const ops: Op[] = [];
  let x = oldLines.length;
  let y = newLines.length;

  for (let d = distance; d > 0; d -= 1) {
    const window = trace[d];
    if (window === undefined) break;
    const k = x - y;
    const down = k === -d || (k !== d && (window[k - 1 + d] ?? 0) < (window[k + 1 + d] ?? 0));
    const previousK = down ? k + 1 : k - 1;
    const previousX = window[previousK + d] ?? 0;
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: '=', text: oldLines[x] ?? '' });
    }
    if (x === previousX) {
      y -= 1;
      ops.push({ kind: '+', text: newLines[y] ?? '' });
    } else {
      x -= 1;
      ops.push({ kind: '-', text: oldLines[x] ?? '' });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: '=', text: oldLines[x] ?? '' });
  }
  ops.reverse();
  return ops;
}

function numbered(ops: readonly Op[]): readonly Entry[] {
  let oldNo = 0;
  let newNo = 0;
  return ops.map((op) => {
    if (op.kind !== '+') oldNo += 1;
    if (op.kind !== '-') newNo += 1;
    return {
      ...op,
      oldNo: op.kind === '+' ? undefined : oldNo,
      newNo: op.kind === '-' ? undefined : newNo,
    };
  });
}

/**
 * 把改动按上下文聚成 hunk。
 *
 * 两处改动之间的相同行不超过 `2 * context` 时并进同一个 hunk——否则会输出两个
 * 尾首相接、上下文重叠的 hunk，那不是合法的 unified diff。
 */
function groupHunks(entries: readonly Entry[], context: number): readonly (readonly number[])[] {
  const changed = entries.flatMap((entry, index) => (entry.kind === '=' ? [] : [index]));
  if (changed.length === 0) return [];

  const groups: number[][] = [];
  let start = changed[0] ?? 0;
  let end = start;
  for (const index of changed.slice(1)) {
    if (index - end <= 2 * context + 1) {
      end = index;
      continue;
    }
    groups.push(range(entries, start, end, context));
    start = index;
    end = index;
  }
  groups.push(range(entries, start, end, context));
  return groups;
}

function range(
  entries: readonly Entry[],
  firstChange: number,
  lastChange: number,
  context: number,
): number[] {
  const from = Math.max(0, firstChange - context);
  const to = Math.min(entries.length - 1, lastChange + context);
  const out: number[] = [];
  for (let index = from; index <= to; index += 1) out.push(index);
  return out;
}

function header(hunk: readonly number[], entries: readonly Entry[]): string {
  let oldCount = 0;
  let newCount = 0;
  let oldStart = 0;
  let newStart = 0;
  for (const index of hunk) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.oldNo !== undefined) {
      oldCount += 1;
      if (oldStart === 0) oldStart = entry.oldNo;
    }
    if (entry.newNo !== undefined) {
      newCount += 1;
      if (newStart === 0) newStart = entry.newNo;
    }
  }
  // 纯插入 / 纯删除的一侧长度为 0，起始行号按 unified diff 惯例取"前一行"
  const oldFrom = oldCount === 0 ? previousNumber(entries, hunk, 'old') : oldStart;
  const newFrom = newCount === 0 ? previousNumber(entries, hunk, 'new') : newStart;
  return `@@ -${String(oldFrom)},${String(oldCount)} +${String(newFrom)},${String(newCount)} @@`;
}

function previousNumber(
  entries: readonly Entry[],
  hunk: readonly number[],
  side: 'old' | 'new',
): number {
  for (let index = (hunk[0] ?? 0) - 1; index >= 0; index -= 1) {
    const number = side === 'old' ? entries[index]?.oldNo : entries[index]?.newNo;
    if (number !== undefined) return number;
  }
  return 0;
}
