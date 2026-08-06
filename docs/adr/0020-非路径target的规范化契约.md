# ADR-0020 · 非路径 target 的规范化契约：一个字符串管着四种完全不同的东西

- **状态**：🟢 Accepted（2026-08-05）
- **日期**：2026-08-05
- **相关**：定案 docs/09 **C4**，关闭 **G3**；把 [ADR-0012](./0012-地基复审与安全边界修正.md) ① 的修法从路径推广到其余三种 target 语义；与 [ADR-0018](./0018-Windows短文件名与路径规范化契约.md) 是同一类问题的第三次出现

## 背景

`PermissionRequest.target` 是一个 `string`，判定统一走 glob。但各能力的 target 根本不是同一种东西：

| 能力 | target 实际是什么 |
|---|---|
| `fs.*` / `self.modify` | 文件系统路径 |
| `net.fetch` / `browser.control` | 网络目的地 |
| `shell.exec` / `process.spawn` | 命令行 |
| `secrets.read` / `git.push` / … | 键名、远端名、设置项 |

路径这一种在 ADR-0012 ① 已经付过一次学费：红线写一种写法、请求传另一种写法，
两边都"是路径"，匹配却永不命中，而输出一直是"规则已配置"。修法是规范化 + 失败关闭。

**那次只修了路径这一种。** 另外三种至今是裸字符串直进 glob（docs/09 G3）。

## 问题：反向演练把它变成了可以指着看的东西

去掉 host 规范化后，对一条最普通的用户规则 `deny net.fetch *.evil.com`：

```
https://evil.com/            → ASK [builtin.tier-fallback]
https://x.evil.com/          → ASK [builtin.tier-fallback]
https://EVIL.com/            → ASK [builtin.tier-fallback]
https://evil.com./           → ASK [builtin.tier-fallback]
https://x.evil.com:443/      → ASK [builtin.tier-fallback]
https://good.com@evil.com/   → ASK [builtin.tier-fallback]
http://2130706433/           → ASK [builtin.tier-fallback]
file:///etc/passwd           → ASK [builtin.tier-fallback]
```

**八种写法，一条都没拦住。** 包括最朴素的那个 `https://evil.com/`——因为 `*.evil.com`
在路径语义下展开成 `[^/]*\.evil\.com`，压根不匹配域名自身。

而 `ask` 的下一步是用户点"允许"。所以这条规则的真实效果不是"拦住"，是"多弹一个框"。

## 决策

### 一、每个能力恰好一种 target 语义，且是**穷尽映射**

```ts
export type TargetKind = 'path' | 'host' | 'command' | 'opaque';
const TARGET_KINDS: Readonly<Record<Capability, TargetKind>> = { … };
```

用 `Record<Capability, TargetKind>` 而不是几个数组：**新增能力时不做这个决定就编译不过**。
与 `CAPABILITY_LABELS` 同一个手法，理由也相同——闭集的价值全在"漏掉一个会当场炸"上，
一旦退化成"漏掉一个就默认按某种处理"，闭集就白设了。

`PATH_CAPABILITIES` 改为从这张表推导，不再单独维护一份：两份列表必然分叉，
而分叉的表现是某个能力悄悄换了判定语义。

`net.listen` 刻意**不是** `host`：它的 target 是本机绑定地址，与"要访问哪个远端"
是相反方向的东西，塞进 URL 归一里只会得到一个错误的答案。

### 二、`host` 完整落地，纯词法，失败关闭

规范化输出 `host[:port]`。每一条都对应上面那张表里的一种绕过：

| 处理 | 输入 → 输出 |
|---|---|
| 大小写归一 | `https://EVIL.com/` → `evil.com` |
| 默认端口归一 | `https://x.evil.com:443/` → `x.evil.com` |
| FQDN 尾点 | `https://evil.com./` → `evil.com` |
| userinfo 丢弃 | `https://good.com@evil.com/` → `evil.com` |
| 数字进制 IP | `http://2130706433/`、`http://0177.0.0.1/`、`http://0x7f.1/` → **拒绝** |
| 百分号编码 | `http://ev%69l.com/` → **拒绝** |
| 非 ASCII（IDN） | `https://еvil.com/`（西里尔 е）→ **拒绝** |
| 非 http(s) | `file://` / `data:` / `ftp://` → **拒绝** |
| 裸主机名 | `evil.com:8080` → **拒绝** |
| IPv6 | 归一到 RFC 5952：`[0:0:0:0:0:0:0:1]` → `[::1]` |

几个决定值得单独说：

- **非 http(s) 那条最要紧。** 放过 `file://` 意味着 `net.fetch file:///etc/passwd`
  变成一条读文件的路径，而它绕开了全部 `fs.*` 规则——判定用的能力是 `net.fetch`，
  路径类红线一条也匹配不上。
- **数字进制 IP 判形而不换算。** 在安全边界上自己实现一遍 `inet_aton`，历史证明很难做对。
  改成：只要每一段看起来都可能是数字/十六进制，它就必须**恰好是规范的点分四段**，否则拒绝。
- **IDN 与百分号编码失败关闭，并说清该谁去做。** 内核零依赖，做不了 IDNA。
  这与 8.3 短文件名的分工完全一致（ADR-0018 决策三）：**有能力做的那一层先转好再送进来**。
- **裸主机名拒绝。** `evil.com:8080` 既可读成"主机 + 端口"，也可读成"scheme + 路径"。
  安全边界上，一个有两种读法的输入只有一种正确处理方式。要求传完整 URL 还顺带修好了
  另一件事：target 变成**工具真正会去请求的那个东西**，而不是它对自己意图的一句概括。
- **IPv6 值得为它写那 40 行。** `[::1]` 与 `[0:0:0:0:0:0:0:1]` 是同一个地址的两种写法。
  这正是 8.3 短名那一类问题——罕见、看起来像兼容性细节、因为罕见所以没人测。
  ADR-0018 的教训就是：**罕见不等于不是绕过。**

### 三、host glob 的 `*.` 前缀也命中域名自身

`*.evil.com` 命中 `evil.com`、`x.evil.com`、`a.b.evil.com`，不命中 `notevil.com`。

这与已有的 `/**` 结尾规则是同一个坑的同一个决定：朴素展开会让「禁止 evil.com 及其子域」
这条规则**对 evil.com 自己失效**，而顶级域名恰恰是最该拦的那个目标。写规则的人不会想到
还要单独再写一条。匹配按 kind 分派，不全局改 glob 语义。

### 四、`command` 失败关闭，契约随工具落地

**契约本身在这里定死**（这是 C4 要的"定"）：

> `shell.exec` / `process.spawn` 的 target 是结构化的 `{ argv: string[], cwd: string }`。
> 规则只匹配 `argv[0]` 的 basename 与解析后的参数。含管道、`sh -c`、shell 元字符的命令
> 无法静态判定，一律降级 ask。**真正的防线是执行器沙箱（docs/09 C2），不是命令行字符串匹配**——
> `rm  -rf /`（两个空格）、`rm -fr /`、`/bin/rm -rf /`、`sh -c 'rm -rf /'`
> 对 glob 来说是四个互不相同的字符串。

**但 M1-a 只落一道闸门**：带非空 target 的命令类判定一律 deny；空 target 照常走
能力级规则（`def.shell-exec` → ask）。

为什么不现在就实现 argv 匹配：M1-a 没有任何 shell 工具能喂它。现在写出来，
就是再造一个**"测试全绿、真实输入下从未跑过"**的东西——而 `trustLevel` 硬编码
（ADR-0017）与 8.3 短名（ADR-0018）两次翻车，恰恰都是这个形状。

闸门是失败关闭的，M1-b 做 `shell.exec` 时绕不过去，只能去实现契约。

### 五、红线不得建立在没有规范化契约的 target 上

`builtinRules()` / `composeRules()` 的**构造期**断言：

- `immutable: true` 的规则若带 `match.target`，其能力的 kind 必须是 `path` 或 `host`
- 任何命令类能力都不许用 `match.target`

这是 G3 那句「非路径能力上的 target 匹配不应被当作安全边界」唯一可执行的形式。
红线是最不能靠巧合的那一类规则——它不可覆盖，用户没有别的手段兜底。

同一道闸门顺带禁掉了 `deny process.spawn "rm -rf /*"` 这类假防线：**它写下的那一刻就炸**，
而不是等到某次判定悄悄不命中。用户级与项目级规则同样过闸门——它们才是最可能写出
"看起来在防、其实没防"的那一批。

`opaque` 上的 target 匹配仍然允许，但只能当**便利过滤**。

## 后果

**正面**

- 一条最普通的 `deny net.fetch *.evil.com` 第一次真的挡得住八种写法
- 「哪一种 target 还没有契约」从一个沉默的缺省分支，变成一件写在类型里、
  且**失败关闭**的事
- 测试 332 → 358

**顺带修出的真 bug**：IPv6 里 `::` 之后紧跟 IPv4 段时，去尾冒号的两个分支写成了同一件事。
`[::ffff:127.0.0.1]` 恰好还对，`[::1.2.3.4]` 直接解析失败。两种形态现在都有用例。

**一批 fixture 当场转红**：测试里能拿 `/work/a.ts` 冒充 URL 和命令行，说明生产里也能——
这批 fixture 从来没验过 target 那一半。默认 target 现在随能力的 kind 而变。

**反向演练**（五条全部当场转红）

| 演练 | 结果 |
|---|---|
| 去掉 host 规范化 | 7 红，其中一条直接打出上面那张八行的绕过表 |
| 放行非 http(s) scheme | 1 红：`net.fetch file:///etc/passwd` 变成放行 |
| `*.` 前缀不覆盖顶级域 | 5 红 |
| 命令类 target 原样放行 | 3 红，含 YOLO 那条 |
| 拆掉构造期闸门 | 2 红：假防线可以被写出来 |

**负面 / 遗留**

- **host 归一只是"写法"层面的防线。** 真正的 SSRF 防御是在发请求的那一层按解析出的
  IP 判定（内网段、link-local、DNS 重绑定）。这里能保证的只是：*同一个目的地的
  不同写法会得到同一个字符串*。M1-b 的 `web.fetch` 必须在能力网关那一层再加一道。
- **命令行契约未实现**，M1-b 的 `shell.exec` 必须一并做掉。
- `opaque` 那一档仍然没有契约（`git.push` 的远端名、`secrets.read` 的键名）。
  当前没有红线依赖它，构造期断言保证将来也不会有——但便利过滤的行为仍然是字面量的。

## 这次值得记住的

这是同一个教训的第三次出现：ADR-0012（路径写法）、ADR-0018（Windows 8.3 短名）、
现在是网络目的地。三次的形状完全一样：

> **安全边界上的字符串匹配，必须配一个规范化契约。**
> 没有契约的那一侧，规则不是弱，是**不存在**——而它看起来和存在一模一样。

而这次多学到的一条是：**没有契约的时候，正确的做法是失败关闭并说出来，
而不是先放一个 glob 在那里顶着。** 顶着的那个 glob 会让所有人以为这里已经防住了。
