import type { Capability } from '@xm/contracts';
import { targetKindOf } from '@xm/contracts';
import { normalizeHostTarget } from './host-target.js';
import type { TargetNormalization } from './target.js';
import { normalizePathTarget } from './target.js';

/**
 * `PermissionRequest.target` 的规范化总入口 —— 按能力的 target 语义分派（ADR-0020）。
 *
 * 在这个文件存在之前，`evaluate()` 里只有一句 `if (isPathCapability(...))`：路径走规范化 +
 * 失败关闭，**其余一切原样进 glob**。也就是说，路径这一种付过学费、修好了，
 * 另外三种连契约都没有，而输出一直是"规则已配置"（docs/09 G3）。
 *
 * 现在四种语义各有各的处置，且每一种的处置都是**明写出来**的——
 * 包括那一种"还没有契约"的，它不再是一个沉默的缺省分支。
 */
export function normalizeTarget(capability: Capability, raw: string): TargetNormalization {
  switch (targetKindOf(capability)) {
    case 'path':
      return normalizePathTarget(raw);

    case 'host':
      return normalizeHostTarget(raw);

    case 'command':
      /*
       * ── 命令行的规范化契约**尚未落地**（docs/09 C4）──
       *
       * 契约本身已经定死在 ADR-0020 决策三：target 是结构化的 `{ argv, cwd }`，
       * 规则只匹配 `argv[0]` 的 basename 与解析后的参数，含管道 / `sh -c` / shell 元字符
       * 一律无法静态判定 → 降级 ask；真正的防线是执行器沙箱（docs/09 C2），
       * 不是命令行字符串匹配——`rm  -rf /`（两个空格）、`rm -fr /`、`/bin/rm -rf /`、
       * `sh -c 'rm -rf /'` 对 glob 来说是四个互不相同的字符串。
       *
       * 但 M1-a 还没有任何 shell 工具能喂它。现在把 argv 匹配实现出来，就是再造一个
       * "测试全绿、真实输入下从未跑过"的东西——`trustLevel` 硬编码（ADR-0017）与
       * 8.3 短名（ADR-0018）两次翻车，恰恰都是这个形状。
       *
       * 所以这里放一道**失败关闭**的闸门：带 target 的命令类判定一律判不了。
       * 它绕不过去，M1-b 做 `shell.exec` 时只能去实现契约，而不是顺手写个 glob。
       *
       * 空 target 放行，是因为它表示"这次请求没有 target"，只由能力级规则判定
       * （`def.shell-exec` → ask）。闸门要拦的是**假的 target 防线**，不是能力本身。
       */
      if (raw === '') return { ok: true, value: '' };
      return {
        ok: false,
        reason:
          `命令行 target 的规范化契约尚未落地（docs/09 C4 / ADR-0020 决策三）。` +
          `用 glob 匹配命令行是出了名的不可靠——同一条 "rm -rf /" 有无数种等价写法，` +
          `在契约落地之前，这里宁可判不了也不给出一层假防线。`,
      };

    case 'opaque':
      /*
       * 自由字符串（密钥键名、远端名、设置项…）。原样通过，**不做任何归一**——
       * 我们并不知道它是什么，猜着归一只会造出新的不一致。
       *
       * ⚠️ 它**不是安全边界**：`deny git.push origin` 挡不住 `deny git.push ORIGIN`
       * 或者一个写成 URL 的远端。只能当便利过滤用。
       * 红线不许建立在它上面，由 `builtinRules()` 的构造期断言强制（defaults.ts）。
       */
      return { ok: true, value: raw };
  }
}
