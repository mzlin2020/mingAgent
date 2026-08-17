# ADR-0081 · Code Mode 的运行域：程序被终止即取消在途子调用

- **状态**：🟢 Accepted
- **日期**：2026-08-17
- **相关**：地基复审四 C2；补 [ADR-0069](./0069-CodeMode的隔离机制.md) 的预算那一节；
  子调用的记录面 [ADR-0072](./0072-CodeMode子调用的记录面与再入口.md)；
  Code Mode 本体 [ADR-0061](./0061-CodeMode与工具SDK生成.md)

## 背景

ADR-0069 把预算做成了两条：客体域里的 interrupt handler（CPU）与宿主侧的墙钟
（`wallClockMs`）。两条都落地了，超预算时 `terminate()` 掉 worker，返回
`{ ok: false, error: { kind: 'timeout' } }`。

**但 `terminate()` 只杀得掉客体域。**

程序调一次工具走的是这条路：客体域 → worker → 宿主 `input.call()` →
`seam.dispatch()` → 完整十二步链 → 真正的 `shell.exec`。前半截随 worker 一起死了，
**后半截是宿主上的一个普通 Promise，没有任何东西管它**。子调用的 `ToolContext.signal`
接的是 `deps.signal`（这一轮的取消信号），与这段程序的死活无关。

实测（`packages/runtime/tests/code-mode.test.ts`，`wallClockMs: 800`）：

```
程序：xm.shell.exec({ argv: ['sleep', '10'] });

800ms   墙钟触发 → run_code 的 tool.end：程序失败（timeout）
        → 模型被告知"这段程序超时终止了"
        → 回合结束、会话关闭
10s     sleep 才真的结束；它的 tool.code.dispatch 这时才想落库，
        而会话已经关了 —— 那条审计干脆丢了
```

于是：**模型看到的与机器上发生的分叉了**，而且完全静默。如果那条命令不是 `sleep`
而是 `rm -rf build && npm install`，它会在"这段程序已经失败"之后继续把活干完。

同一个洞在用户点停止时更明显：`run_code` 收到 `aborted`，程序停了，
它派发出去的工具照跑。

## 决策

**`CodeRuntime` 的绑定回调多一个参数：这一次 `run()` 的运行域信号。**

```ts
call(request: CodeBindingCall, signal: AbortLike): Promise<CodeBindingResult>;
```

- **提供者给**（`quickjs.ts`）：每次 `run()` 起一个 `AbortController`，
  在 `finish()` 里第一件事就 abort 它——正常结束、超时、CPU、内存、被取消、
  隔离层死亡，六条路一条不落。
- **接缝接**（`turn-code.ts`）：子调用的 `ToolContext.signal` 是
  **`deps.signal` 与运行域的并集**（`linkAbort()`）。这一轮被停要停，
  这段程序被终止也要停。
- **已经 abort 之后送进来的调用不派发**，直接返回一条 `ok: false, code: 'aborted'`
  的结果。挡的是 abort 与 worker 真正停下之间那个窗口。

### 收尾要等一小会儿

`finish()` abort 之后**不立即 resolve**，先等在途的子调用收尾，上限 1 秒
（`TEARDOWN_GRACE_MS`）。理由是审计顺序：不等的话，一条 `tool.code.dispatch` 会落在
`run_code` 的 `tool.end` 之后，甚至落在会话关闭之后（那时它直接丢失，
上面那段实测就是这个结果）。

上限是必须的：工具**应当**很快响应 abort，但"应当"不是保证，而一个不肯停的工具
不该把整段程序的失败上报也一起拖住。宽限期过了就先把结果交出去。

### 为什么不是"让客体域自己等"

因为客体域已经死了。这件事的性质是：**隔离层能停的只有它自己那一半，
宿主这边的活得靠一个信号停**。把它写进端口注释，而不是留给每个提供者自己想。

## 反向演练

| 演练 | 结果 |
|---|---|
| 墙钟 500ms + 一个永不返回的绑定调用（`quickjs.test.ts`） | `timeout`；`call` 拿到的 signal 已 abort，且它的 `abort` 监听器**真的被触发过** |
| 墙钟 800ms + 程序里 `shell.exec(['sleep','10'])`（`code-mode.test.ts`，真工具真进程） | 子调用有一条 `tool.code.dispatch`、`ok: false`，且它排在 `tool.end` **之前**；整条用例 6 秒内跑完 |
| 同一条用例跑在修复前的代码上 | `dispatches` 为**空数组**——审计根本没落下来 |

## 后果

- **正面**：程序终止是**真终止**，副作用不再越过它继续发生；子调用的审计顺序
  与"模型看到了什么"重新一致。
- **负面**：
  - 失败路径最多多等 1 秒。已经等过 30 秒墙钟的场景里这不算什么，
    但测试里每条超时用例都会多这 1 秒。
  - `CodeRuntime` 端口的签名变了。今天只有一个实现（QuickJS）与几个测试替身，
    但它是**端口**，将来的第三方实现必须照做——所以约束写在端口注释里，不写在实现里。
  - 一个忽略 `signal` 的工具仍然会跑完自己。这是工具契约的问题，不是这里能解决的；
    宽限期只保证它不再拖住上报。
- **重新评估的条件**：出现第二个执行世界（容器/远端）时，"abort 能不能传过去"
  要重新回答一次——那时这个信号需要跨进程/跨机器传递。
