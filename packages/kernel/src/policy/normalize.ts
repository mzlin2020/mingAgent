import type { Capability } from '@xm/contracts';
import { targetKindOf } from '@xm/contracts';
import { normalizeCommandTarget } from './command-target.js';
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
       * ── 命令行的规范化契约（ADR-0026 落地，ADR-0020 决策三欠下的那半张）──
       *
       * 这里以前是一道失败关闭的闸门：带非空 target 的命令类判定一律判不了。
       * 那道闸门当时是对的，也确实起了作用——M1-d 做 `shell.exec` 时绕不过去，
       * 只能来把契约补上，而不是顺手写个 glob 顶着。
       *
       * 现在归一到规范形式：`argv[0]` 取 basename、参数间恒为单空格、需要引号的
       * 参数只有一种写法。于是 `rm  -rf /`（双空格）与 `/bin/rm -rf /` 得到同一个串。
       *
       * ⚠️ **但这个串仍然不是防线。** `rm -fr /` 与 `rm -rf /` 归一之后照样是两个串，
       * 谁也没法穷举命令行的等价写法。真正拦住 `rm -rf /` 的是
       * `command-claims.ts` 从这条命令里拆出来的那条 `fs.delete /` 主张——
       * 它撞的是一条按**路径**写的红线。命令串只用来做便利过滤与会话授权，
       * 所以红线仍然不许建立在它上面（`defaults.ts` 的构造期闸门只放开了非红线那一半）。
       *
       * 空 target 照旧放行：它表示"这次请求没有 target"，只由能力级规则判定。
       */
      return normalizeCommandTarget(raw);

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
