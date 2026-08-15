import type { EventOf, XmEventType } from '@xm/contracts';
import { isKnownEventType } from '@xm/contracts';
import type { SessionState } from '../state/session-state.js';

/**
 * 运行时不变量注册表（ADR-0060）。
 *
 * ── 它解决的是哪一类失效 ──
 *
 * 本仓库栽过八次"规则存在但从未生效"，形态出奇一致：**静态检查证明的是"东西存在"，
 * 而失效的永远是"它在真实运行里起没起作用"**。单元测试对这类失效同样免疫——
 * `truncateResult` 有 12 条用例全绿，而 `executeCall` 里一次也没调过它。
 *
 * 所以这里断言的东西必须满足一个条件：**只有真的跑起来才检验得到**。
 * 它挂在事件流上，每写一条事件核一次。
 *
 * ── 为什么检查函数只能看见事件与前后状态 ──
 *
 * 这三个入参就是全部（没有服务、没有容器、没有注册表）。于是
 * "断言 `ctx.tools` 服务存在"这种伪不变量在**接口上就写不出来**——想写只能闭包捕获
 * 一个外部引用，而那正是 `scripts/check-invariants.mjs` 盯着的东西。
 *
 * 类型与加载期的事归类型与加载期，纯函数在固定输入上的结果归单元测试。
 * 这里只放它们都够不着的那一类：**可观察的关系**。
 */

export interface InvariantEvent<T extends XmEventType = XmEventType> {
  readonly event: EventOf<T>;
  /** 这条事件**归约之前**的状态 */
  readonly before: SessionState;
  /** 归约之后的状态 */
  readonly after: SessionState;
}

/** 返回一句话即违例；返回 `undefined` 表示这条事件上这个不变量成立。 */
export type InvariantCheck<T extends XmEventType = XmEventType> = (
  ctx: InvariantEvent<T>,
) => string | undefined;

export interface InvariantApi {
  /**
   * 在某几种事件上核一个不变量。
   *
   * `types` 必须是真实存在的事件类型：一个盯着不存在事件的不变量永远不会被调用，
   * 而它在报告里长得跟"一直成立"一模一样——那是最坏的一种假绿。
   */
  on<T extends XmEventType>(types: readonly T[], name: string, check: InvariantCheck<T>): void;
}

export type InvariantInstaller = (api: InvariantApi) => void;

export interface InvariantViolation {
  readonly package: string;
  readonly invariant: string;
  readonly message: string;
  readonly seq: number;
  readonly eventType: XmEventType;
}

export class InvariantError extends Error {
  override readonly name = 'InvariantError';
  readonly violations: readonly InvariantViolation[];

  constructor(violations: readonly InvariantViolation[]) {
    super(
      `运行时不变量被破坏：\n${violations
        .map((v) => `  · [${v.package}] ${v.invariant}（seq=${String(v.seq)}）：${v.message}`)
        .join('\n')}`,
    );
    this.violations = violations;
  }
}

interface Entry {
  readonly package: string;
  readonly name: string;
  readonly check: InvariantCheck;
}

/**
 * 声明的事件类型窄化了 `check` 的入参，而注册表按类型分桶存的是宽签名。
 * 这一次逆变转换是安全的：这条 check 只会从它自己声明的那几个桶里被取出来调用。
 */
const widen = <T extends XmEventType>(check: InvariantCheck<T>): InvariantCheck =>
  check as unknown as InvariantCheck;

const PACKAGE_NAME = /^@xm\/[a-z][a-z0-9-]*$/;

export class InvariantRegistry {
  readonly #byType = new Map<XmEventType, Entry[]>();
  readonly #packages = new Set<string>();
  readonly #violations: InvariantViolation[] = [];

  /**
   * 注册一个包的不变量。返回撤销函数——插件卸载时它的不变量必须跟着消失，
   * 否则卸载之后仍有一条断言在盯着一个已经不存在的关系。
   */
  register(packageName: string, install: InvariantInstaller): () => void {
    if (!PACKAGE_NAME.test(packageName)) {
      throw new Error(`不变量的注册名必须是包名（形如 @xm/kernel），收到 "${packageName}"。`);
    }
    if (this.#packages.has(packageName)) {
      throw new Error(`包 ${packageName} 的不变量已经注册过了。`);
    }
    this.#packages.add(packageName);

    const added: { type: XmEventType; entry: Entry }[] = [];
    install({
      on: (types, name, check) => {
        if (types.length === 0) {
          throw new Error(`不变量 ${name}（${packageName}）没有声明任何事件类型。`);
        }
        for (const type of types) {
          if (!isKnownEventType(type)) {
            throw new Error(
              `不变量 ${name}（${packageName}）盯着不存在的事件类型 "${String(type)}"。`,
            );
          }
          const entry: Entry = { package: packageName, name, check: widen(check) };
          const list = this.#byType.get(type) ?? [];
          list.push(entry);
          this.#byType.set(type, list);
          added.push({ type, entry });
        }
      },
    });

    return () => {
      for (const { type, entry } of added) {
        const list = this.#byType.get(type);
        if (list === undefined) continue;
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
      }
      this.#packages.delete(packageName);
    };
  }

  get packages(): readonly string[] {
    return [...this.#packages].sort();
  }

  /** 已注册的不变量总数，供装配期自检"这台机器上到底装了几条"。 */
  get size(): number {
    let total = 0;
    for (const list of this.#byType.values()) total += list.length;
    return total;
  }

  /**
   * 本次运行里出现过的全部违例，**只增不清**。
   *
   * 为什么光靠抛出不够：`check()` 的调用点在 `SessionRuntime.record()` 里，而它的
   * 上游（`executeCall`）为了把工具失败变成一条 `tool.end` 而 catch 掉了一切——
   * 于是一次真实的违例会被"翻译"成一次普通的工具失败，安静地过去。
   * 这不是假想：M3-g 的反向演练里第一版就是这么被吞掉的（收官记录有记）。
   *
   * 所以违例有两条出路：抛出（给没人 catch 的调用点）与这份清单（给闸门与用例）。
   * 清单不会被任何 try/catch 吃掉。
   */
  get violations(): readonly InvariantViolation[] {
    return this.#violations;
  }

  /**
   * 核一条事件。**一条检查抛出不会打断其余检查**——不变量之间互不负责，
   * 一条写坏的断言不该把别的断言一起变成哑巴（`docs/05` 红线三的同一个道理）。
   */
  check(ctx: InvariantEvent): readonly InvariantViolation[] {
    const list = this.#byType.get(ctx.event.type);
    if (list === undefined || list.length === 0) return [];

    const violations: InvariantViolation[] = [];
    for (const entry of list) {
      let message: string | undefined;
      try {
        message = entry.check(ctx);
      } catch (error) {
        message = `检查函数自身抛出：${error instanceof Error ? error.message : String(error)}`;
      }
      if (message !== undefined) {
        violations.push({
          package: entry.package,
          invariant: entry.name,
          message,
          seq: ctx.event.seq,
          eventType: ctx.event.type,
        });
      }
    }
    this.#violations.push(...violations);
    return violations;
  }
}
