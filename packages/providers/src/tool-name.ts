/**
 * 工具名的 wire 编解码。
 *
 * ── 问题 ──
 *
 * Anthropic 与 OpenAI 兼容端点都要求 `tools[].function.name` /
 * `tools[].name` 匹配 `^[a-zA-Z0-9_-]{1,128}$`，而我们的工具名就是能力字符串
 * 本身（`fs.read`、`shell.exec`）——带点号。两个适配器把 `t.name` 原样塞进
 * wire body 时都会被各自的服务端拒绝：DeepSeek（OpenAI 兼容）400 说得明白，
 * Anthropic 大概率是同一个坑，只是没人拿真实的点号工具名手动跑过
 * `XM_LIVE_PROVIDER=1`（M1-c 才装上带点号的真实工具，M1-b 写 live 用例时
 * 用的还是假想的 `weather.get`）。
 *
 * ── 为什么编解码是共享的一对函数，不是两个适配器各写一份 ──
 *
 * 各自修一遍，早晚有一天两边的映射规则会悄悄分叉——这个仓库反复栽的形状。
 * 发出去用什么名字，收回来就必须按**同一份表**翻译回去，不能各算各的。
 *
 * ── 为什么表是「针对这次请求现算」，不是一个全局固定的 `.` → `_` 替换 ──
 *
 * 全局固定替换今天够用（能力表是闭集，`fs.read`/`fs.list`/`fs.write`/
 * `shell.exec` 清洗后互不相同），但插件工具（M3）的名字不受这份闭集约束，
 * 两个不同的原名清洗后完全可能撞车（`a.b` 与 `a_b` 都会变成 `a_b`）。
 * 撞车的后果不是报错，是**服务端回传的 tool_call 被路由到错误的工具**——
 * 这比在这里多算一次哈希严重得多。所以编解码表按每次请求的 `tools` 列表现算，
 * 撞车时追加数字后缀直到唯一。
 *
 * `decode` 查不到的名字（服务端出于某种原因回传了一个我们没申报过的名字）
 * 原样返回而不是抛错——"服务端给了个不认识的名字"该由上层的工具注册表判定
 * "没有这个工具"并走已有的失败路径，编解码这一层不该替它决定后果。
 */
export interface ToolNameCodec {
  /** 内部名（能力字符串）→ wire 名 */
  readonly encode: (name: string) => string;
  /** wire 名 → 内部名。查不到就原样返回 */
  readonly decode: (wireName: string) => string;
}

const WIRE_SAFE = /^[a-zA-Z0-9_-]+$/;
const sanitize = (name: string): string =>
  WIRE_SAFE.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, '_');

export function buildToolNameCodec(names: readonly string[]): ToolNameCodec {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();

  for (const name of names) {
    if (toWire.has(name)) continue; // 同一个名字在列表里出现两次

    let candidate = sanitize(name);
    let suffix = 1;
    // 与之前某个不同的原名撞了同一个清洗结果：追加后缀直到不撞
    while (fromWire.has(candidate) && fromWire.get(candidate) !== name) {
      candidate = `${sanitize(name)}_${String(suffix)}`;
      suffix++;
    }
    toWire.set(name, candidate);
    fromWire.set(candidate, name);
  }

  return {
    encode: (name) => toWire.get(name) ?? sanitize(name),
    decode: (wireName) => fromWire.get(wireName) ?? wireName,
  };
}
