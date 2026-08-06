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

/**
 * Windows 8.3 短文件名的一段，如 `PROGRA~1`、`RUNNER~1`、`MYDOCU~1.TXT`。
 * 形态是「至多 6 个字符 + `~` + 序号」，可带至多 3 字符的扩展名。
 */
const SHORT_NAME_8_3 = /^[^/]{1,6}~\d{1,3}(\.[^/.]{1,3})?$/;

export function normalizePathTarget(raw: string): TargetNormalization {
  if (raw === '') {
    return { ok: false, reason: '目标路径为空' };
  }
  if (raw.includes('\0')) {
    // 空字节截断是绕过路径检查的经典手法：检查看到的是全串，系统调用看到的是前半截
    return { ok: false, reason: '目标路径含空字节' };
  }
  /*
   * 未展开的家目录。
   *
   * ⚠️ 只看**开头**的 `~`，不是"含有 `~`"。
   *
   * 原来写的是 `raw.includes('~')`，本意没错（`~/Documents` 这种没展开的路径判不了），
   * 但它把两件完全不同的事混成了一条规则，代价是 **Windows 上整个应用起不来**：
   * `~` 在 Windows 8.3 短文件名里是合法字符——`RUNNER~1`、`PROGRA~1`、`DOCUME~1`——
   * 于是 `C:\Users\RUNNER~1\AppData\...` 被当成"没展开的家目录"拒掉，
   * 而这正是 `os.tmpdir()` 在 Windows 上返回的形态（三平台 CI 首次实跑才照出来）。
   *
   * shell 的家目录展开语法永远是行首：`~`、`~/x`、`~user/x`。段中间的 `~` 与它无关
   * （POSIX 上还有 emacs/vim 的备份文件 `foo.txt~`，同样是合法路径）。
   */
  if (/^~([/\\]|$)/.test(raw) || /^~[^/\\]+[/\\]/.test(raw)) {
    return {
      ok: false,
      reason: `目标路径以 "~" 开头，说明调用方没有展开家目录。内核不做展开（零 I/O），无法判定。`,
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

    /*
     * Windows 8.3 短文件名 —— **必须拒绝，理由是安全而不是洁癖。**
     *
     * `C:/PROGRA~1/Foo` 与 `C:/Program Files/Foo` 是**同一个文件的两种写法**。
     * 红线是字面量 glob：规则按长名写、请求按短名来，就匹配不上——
     * 这和"同一个文件写成相对路径就能绕过红线"是同一类绕过，只是换了个 Windows 特有的马甲。
     *
     * 内核解析不了它（短名↔长名要问文件系统，而内核零 I/O），所以**失败关闭**：
     * 由有文件系统的那一层（`@xm/platform` 的 `resolvePaths`，以及将来的能力网关）
     * 先 realpath 成长名再送进来。这与符号链接的分工完全一致，见本文件顶部说明。
     *
     * 只在**确认是 Windows 路径**（有盘符）时才查，POSIX 路径不受影响：
     * `/home/u/v1~2` 在 POSIX 上就是个普通文件名，没有别名语义。
     */
    const short = rest.split('/').find((seg) => SHORT_NAME_8_3.test(seg));
    if (short !== undefined) {
      return {
        ok: false,
        reason:
          `目标路径含 Windows 8.3 短文件名段 "${short}"。它是长文件名的**别名**，` +
          `按短名写的路径匹配不上按长名写的红线。内核无法解析（需要文件系统），` +
          `请调用方先 realpath 成长名再送进来。`,
      };
    }
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
 * 规则**模式**（glob）的坐标系归一 —— 与 `normalizePathTarget` 是同一枚硬币的两面。
 *
 * ── 为什么模式也要归一 ──
 *
 * `normalizePathTarget` 把请求的 target 统一成 `C:/Users/...`（正斜杠、盘符大写），
 * 而规则的 `match.target` 是**用户手写或程序合成的原样字符串**。Windows 上这两者
 * 天然对不上：用户在 config.json 里写 `"C:\\Users\\me\\secrets\\**"`（JSON 转义后
 * 是单反斜杠），判定时拿它去匹配 `C:/Users/me/secrets/x`——**一个字符都对不上，
 * 于是这条 deny 规则静默失效**。三平台 CI 第一次跑真实文件工具时照出的就是这个：
 * 一条写着真实路径的 deny 规则，在 Windows 上完全不生效（approval.test 的符号链接用例）。
 *
 * 归一放在**匹配器里**，不是放在每个模式的生产者那里。生产者有三个——内置默认、
 * 配置加载、授权合成——而"三个地方各自记得做同一件事"正是这个仓库反复栽的形状。
 * 匹配器只有一个，让它保证两边同坐标系，就没有分叉的机会。
 *
 * ── 只对 Windows 盘符绝对路径动手 ──
 *
 * 反斜杠在这里有两个身份：Windows 的路径分隔符，和本 glob 的**转义符**（`\*` / `\?`）。
 * 二者只在一种情况下不冲突——**Windows 文件名里根本不允许出现 `\` `*` `?`**，
 * 所以在一个 `C:/` 打头的模式里，反斜杠只可能是分隔符，不可能是转义。
 * 反过来 POSIX 上 `a*b`、`a\b` 都是合法文件名，那里的反斜杠必须继续当转义符
 * （`escapeGlobPattern` 依赖这一点），所以非盘符模式**一个字节都不动**。
 */
export function normalizePathPattern(pattern: string): string {
  if (!/^[a-zA-Z]:[\\/]/.test(pattern)) return pattern;
  // 分隔符统一并折叠重复（`C:\\Users` 这种双写在 JSON 里很常见）；盘符大写，与 target 一致
  const slashed = pattern.replace(/[\\/]+/g, '/');
  return `${(slashed[0] ?? '').toUpperCase()}${slashed.slice(1)}`;
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
