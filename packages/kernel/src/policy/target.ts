/**
 * 路径目标的规范化 —— 安全边界上的**词法**归一。
 *
 * ── 为什么必须有这一层 ──
 *
 * 红线规则是字符串 glob，`PermissionRequest.target` 是运行时给的字符串。两边对不上，
 * 规则就形同虚设。2026-08-04 实测（`tests/policy-target.test.ts` 已固化为回归用例）：
 *
 *   · 红线写 `target: '/'`，运行时传 `/tmp/..` → 不命中，降级成 ask
 *   · 红线写 `target: '~'`，而运行时传的一定是展开后的 `/home/ming` → **永不命中**
 *   · 自改红线写 `<globstar>/packages/kernel/src/policy/<globstar>`，传相对路径 → 不命中
 *     （这里不敢写字面量：`<globstar>` 后面跟 `/` 会把本段块注释提前闭合，ADR-0011 ⑫）
 *
 * 三条红线在真实输入下几乎全是摆设，而输出一直是"规则已配置"。这正是 ADR-0011 那条
 * 纪律的又一个实例：**规则存在 ≠ 规则生效**。
 *
 * ── 边界在哪 ──
 *
 * 这里只做**词法**规范化：分隔符统一、重复斜杠折叠、`.` 与 `..` 按字面消解、去尾斜杠。
 * 不做、也做不了的：符号链接解析、`~` 展开、大小写折叠、真实存在性检查——那些都需要
 * 文件系统，而内核零 I/O。
 *
 * 所以规范化**失败关闭**：拿到相对路径或仍含 `~` 的目标，一律判为不可判定，
 * PolicyEngine 直接 deny。宁可让一个配错的调用方立刻炸，也不要让它悄悄落到 ask
 * ——ask 的下一步是用户点"允许"。
 *
 * 符号链接逃逸由运行时的能力网关在**规范化之后**负责（docs/05 §2.2），
 * 那一层有文件系统，能 realpath。两层职责不重叠。
 */

export type TargetNormalization =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/** `C:\x`、`c:/x` 这类 Windows 绝对路径 */
const WINDOWS_ABSOLUTE = /^([a-zA-Z]):[\\/]/;

export function normalizePathTarget(raw: string): TargetNormalization {
  if (raw === '') {
    return { ok: false, reason: '目标路径为空' };
  }
  if (raw.includes('\0')) {
    // 空字节截断是绕过路径检查的经典手法：检查看到的是全串，系统调用看到的是前半截
    return { ok: false, reason: '目标路径含空字节' };
  }
  if (raw.includes('~')) {
    return {
      ok: false,
      reason: `目标路径含 "~"，说明调用方没有展开家目录。内核不做展开（零 I/O），无法判定。`,
    };
  }

  const slashed = raw.replace(/\\/g, '/');

  let prefix = '';
  let rest: string;
  const win = WINDOWS_ABSOLUTE.exec(slashed);
  if (win !== null) {
    // 盘符统一成大写。注意 Windows 路径**大小写不敏感**，而这里的匹配是敏感的——
    // 由 EvaluateInput.pathCaseInsensitive 交给知道平台的运行时打开。
    prefix = `${(win[1] ?? '').toUpperCase()}:`;
    rest = slashed.slice(win[0].length - 1);
  } else if (slashed.startsWith('/')) {
    rest = slashed;
  } else {
    return {
      ok: false,
      reason: `目标路径 "${raw}" 不是绝对路径。相对路径的含义取决于工作目录，` +
        `而规则匹配的是字面量——同一个文件写成相对路径就能绕过红线。`,
    };
  }

  const out: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // 越过根就停在根：`/tmp/../..` 与 `/` 是同一个位置
      out.pop();
      continue;
    }
    out.push(segment);
  }

  // 段是逐个拼回去的，所以天然没有重复斜杠、没有尾斜杠；根目录退化成 "/" 或 "C:/"
  return { ok: true, value: `${prefix}/${out.join('/')}` };
}

/**
 * 规范化后的路径拼接，供红线规则构造使用。
 * 传进来的片段必须已经是绝对路径，否则抛错——红线的构造期出错好过运行期失效。
 */
export function normalizedOrThrow(raw: string): string {
  const r = normalizePathTarget(raw);
  if (!r.ok) {
    throw new Error(`无法把 "${raw}" 规范化成绝对路径：${r.reason}`);
  }
  return r.value;
}
