# ADR-0018 · Windows 8.3 短文件名：`~` 的两种含义，以及一条只在 Windows 上存在的红线绕过

- **状态**：🟢 Accepted（2026-08-05）
- **日期**：2026-08-05
- **相关**：细化 [ADR-0012](./0012-地基复审与安全边界修正.md) ① 的路径规范化契约；验证 [ADR-0007](./0007-平台支持分级.md)「Windows 是 Tier 1」；由 [ADR-0016](./0016-原生模块与打包.md) 记的三平台 CI 首跑发现

## 背景

三平台 CI 第一次真跑（2026-08-05），Linux 与 macOS 上 314 个测试全绿，**Windows 上四条红**，全部指向同一个地方：

```
Error: 无法把 "C:\Users\RUNNER~1\AppData\Local\Temp\xm-smoke-wPRAfd\run1"
       规范化成绝对路径：目标路径含 "~"，说明调用方没有展开家目录。
 ❯ normalizedOrThrow  packages/kernel/src/policy/target.ts:95
 ❯ resolvePaths       packages/platform/src/paths.ts:48
 ❯ nodePlatform       packages/platform/src/node-platform.ts:23
```

`RUNNER~1` 是 Windows 的 **8.3 短文件名**：`runneradmin` 超过 8 个字符，系统给了它一个别名。`os.tmpdir()` 在 Windows 上返回的就是这个形态，`%ProgramFiles%` 同理（`C:\PROGRA~1`）。

而 `normalizePathTarget` 当时的第三行是：

```ts
if (raw.includes('~')) {
  return { ok: false, reason: `目标路径含 "~"，说明调用方没有展开家目录……` };
}
```

## 问题：一条规则同时管了两件不相干的事

| 现象 | 语法形态 | 该怎么处理 |
|---|---|---|
| 没展开的家目录 `~/Documents` | `~` 永远在**行首** | 拒绝，让调用方先展开 |
| Windows 8.3 短名 `PROGRA~1` | `~` 在**段中间** | 拒绝，但理由完全不同（见下） |
| POSIX 备份文件 `notes.txt~` | `~` 在段尾 | **合法路径，不该拒** |

混成一条 `includes('~')` 的代价是双向的：

- **误杀**：Windows 上 `resolvePaths()` 在启动时就抛，**应用根本起不来**。POSIX 上 emacs / vim 的备份文件 `foo.txt~` 也一律判不了。
- **漏说**：真正该防的别名问题，从来没有被单独说清过——它只是碰巧被那条过宽的规则盖住了。而"碰巧盖住"和"没有防护"之间只差一次合理的放宽。

## 8.3 短名为什么是安全问题，不只是兼容问题

`C:/PROGRA~1/Foo` 与 `C:/Program Files/Foo` 是**同一个文件的两种写法**。红线是字面量 glob，按长名写的规则匹配不上短名——这与 ADR-0012 ① 记的"同一个文件写成相对路径就能绕过红线"是同一类绕过，只是换了个 Windows 特有的马甲。

反向演练把它变成了可以指着看的东西。去掉 8.3 检查后，对同一个受红线保护的文件：

```
长名 C:/Program Files/xiaoming/scripts/check-secrets.mjs → DENY  [red.self-modify-05-fs-write]
短名 C:/PROGRA~1/xiaoming/scripts/check-secrets.mjs      → ALLOW [builtin.tier-fallback]
```

**同一个文件，两种写法，两种结果。** 而 `scripts/**` 正是「改了它就没人拦得住后续改动」那一组（ADR-0017 决策二）。

## 决策

### 一、`~` 的检查收窄到**行首**，只管它本来要管的那件事

```ts
if (/^~([/\\]|$)/.test(raw) || /^~[^/\\]+[/\\]/.test(raw)) { … }
```

shell 的家目录展开语法永远在行首（`~`、`~/x`、`~user/x`）。段中间的 `~` 与它无关。

收窄是**安全**的：`~/x` 本来就不是绝对路径，即使这条分支放过它，下面的"必须是绝对路径"仍会拒绝。这条分支的价值只在于给出一个更准确的错误信息。

### 二、8.3 短名单独成一条检查，**失败关闭**，且只对 Windows 路径生效

```ts
const SHORT_NAME_8_3 = /^[^/]{1,6}~\d{1,3}(\.[^/.]{1,3})?$/;
```

三个设计点：

- **失败关闭而不是放行。** 内核解析不了短名——那需要问文件系统，而内核零 I/O（ADR-0007 保险 1）。判不了就拒，理由与路径规范化的整体立场一致：*宁可让配错的调用方立刻炸，也不要让它悄悄落到 ask*。
- **只在确认是 Windows 路径（有盘符）时才查。** `/home/u/v1~2` 在 POSIX 上就是个普通文件名，没有别名语义，不该被这条规则波及。内核不知道自己跑在哪个平台，但它**知道这个字符串长什么样**——盘符是路径自身携带的信息，不是环境信息。
- **错误信息要说清下一步**：「请调用方先 realpath 成长名再送进来」。失败关闭如果不告诉人怎么办，就会被绕过。

### 三、解析短名是**平台层**的职责

`packages/platform/src/paths.ts` 增加 `resolveWindowsShortName()`，用 `realpathSync.native()`（走 OS API，纯 JS 的 realpath 还原不了短名）。

这与符号链接的分工完全一致，`target.ts` 顶部早就写下了这条边界：

> 符号链接逃逸由运行时的能力网关在**规范化之后**负责，那一层有文件系统，能 realpath。两层职责不重叠。

两个实现细节：

- **路径可能还不存在**（数据目录是用到才建的），所以从最深的**已存在**祖先开始 realpath，再把剩下的段拼回去。整条都不存在就原样返回，交给内核那侧失败关闭。
- **只对 Windows 短名生效，POSIX 路径一个字节都不动。** `realpath` 会顺带解析符号链接，而那会把 macOS 的 `/var/…` 变成 `/private/var/…`——那是与本次修复无关的行为改变，要动得单独决策。

### 四、临时目录清理在 Windows 上必须带 `maxRetries`

```ts
rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
```

POSIX 允许删除仍被打开的文件，Windows 不允许：只要 better-sqlite3 还有一个句柄没关（或 WAL 的 `-wal` / `-shm` 还挂着），`unlink` 就是 `EBUSY`。`force: true` 只忽略"不存在"，不忽略"被占用"。

## 后果

**正面**

- Windows 上应用能起来了；`~` 不再误杀 POSIX 的备份文件
- 8.3 别名从"碰巧被一条过宽的规则盖住"变成"有名有姓、有用例、有反向演练的一条防线"
- 测试 314 → 319

**反向演练**（两条都当场转红）

| 演练 | 结果 |
|---|---|
| `~` 检查退回 `includes('~')` | 2 条红：`notes.txt~` 被误杀；8.3 报错理由串味 |
| 放行 8.3 短名 | 2 条红，其中一条直接把绕过打出来：短名 `allow` vs 长名 `deny` |

**负面 / 遗留**

- **`resolvePaths` 只覆盖了小明自己的六个目录。** 模型让工具去动 `C:\PROGRA~1\…` 时，target 仍然是短名，会被内核失败关闭地拒掉——**行为是安全的，但用户会撞到一个他没法自己解决的拒绝**。真正的解法是能力网关在判定前 realpath，那属于 docs/09 G3（非路径能力与 target 规范化契约），M1 引入真实文件工具时一并做。
- UNC 路径（`\\server\share`）目前不被 `WINDOWS_ABSOLUTE` 识别，会当成 POSIX 绝对路径处理，因而**不做 8.3 检查**。M1 接真实文件工具前要补。
- `SHORT_NAME_8_3` 会误判真实存在的 `backup~1` 这类文件名。取舍是刻意的：安全边界上宁可误拒。

## 这次值得记住的

「Windows 是 Tier 1」在此之前完全建立在**代码里没有硬编码 POSIX 路径**这个静态观察上。真正拦住人的是两个跟路径写法毫无关系的东西：一个进程启动 API（`.cmd` 的 EINVAL，见 ADR-0016 首跑记录）和一个文件名别名机制。

> **跨平台支持和红线、护栏是同一类东西：没在那个平台上真跑过，就是没有支持。**
