import type {
  BlobRef,
  CallId,
  ContentBlock,
  Message,
  MessageId,
  ModelRequest,
  PermissionRequest,
  PolicyVerdict,
  PriceTable,
  ResultBlock,
  StopReason,
  TurnId,
} from '@xm/contracts';
import { newCheckpointId, newMessageId, newRequestId, newTurnId, xmError } from '@xm/contracts';
import type {
  AbortLike,
  BlobStore,
  Checkpointer,
  ModelProvider,
  PermissionClaim,
  RegisteredTool,
  RuleLayer,
  ToolContext,
  ToolGateway,
  ToolRegistry,
} from '@xm/kernel';
import {
  GatewayError,
  ToolInputError,
  claimsOfCapabilities,
  costOf,
  evaluate,
  lookupPrice,
  truncateResult,
} from '@xm/kernel';
import type { SessionRuntime } from './session-runtime.js';

/**
 * 极薄的 Turn 循环（M0-b）。
 *
 * **它刻意不完整。** 没有 ContextBuilder、没有上下文压缩、没有并行调度、
 * 没有子 Agent——那些是 M1/M2。这里只做一件事：把
 * `Provider → 事件 → 权限闸门 → 工具 → 事件` 这条链子接通，让它在真实的 SQLite 上跑一遍。
 *
 * 之所以现在就要这条链子，是因为它是几个架构约束**唯一**的实测点：
 * runtime 不依赖 electron、内核纯逻辑能被装配、事件流能完整回放出状态。
 * 这些约束在 M0-a 全是纸面上的。
 *
 * 三条在这里落地的不变量：
 *   · `seq` 只由 `SessionRuntime` 分配（不变量三）
 *   · 广播排在落库之后（不变量五）
 *   · 工具**执行前**必过 PolicyEngine——闸门长在路径上，不是长在文档里
 */

export interface TurnDeps {
  readonly runtime: SessionRuntime;
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  /**
   * 规则层。顺序即优先级，后面的层胜（engine.ts）：内置 → 用户级 → 项目级。
   *
   * ADR-0039 之前这里还会在判定前追加一层"本会话的授权"（`grantsToRules(state.grants)`
   * 现算）。审批删掉之后没有会话层了，这份配置就是判定看到的全部规则——
   * 它现在是静态的，装配一次即可。
   */
  readonly layers: readonly RuleLayer[];
  readonly model: string;
  readonly signal?: AbortLike;
  /** Windows 必须为 true，否则改个大小写就绕过红线（见 PolicyEngine 注释） */
  readonly pathCaseInsensitive?: boolean;
  /**
   * 能力网关：把已校验的入参解析成"判定与执行共用的那一个值"（ADR-0024）。
   *
   * **不提供就等于没有路径工具**——省略时所有 target 为空，路径类能力的判定会
   * 落到能力级规则上。真实文件工具必须配 `nodeToolGateway`，否则符号链接、
   * 相对路径、Windows 短名三条路全部敞着。
   */
  readonly gateway?: ToolGateway;
  /**
   * 破坏性调用的写前快照（ADR-0003 的"无条件还原点"）。
   *
   * 省略即**没有还原点**——这在测试与冒烟里是可以接受的，在桌面端不是。
   */
  readonly checkpointer?: Checkpointer;
  /**
   * 结果截断时存放全文的地方。
   *
   * 省略不影响截断本身，只影响截断标记里有没有"完整内容在哪"。
   */
  readonly blobs?: BlobStore;
  /** 价格表。缺省或查不到该模型时成本记 0 且标 `priced: false`（见 kernel/model/cost.ts） */
  readonly prices?: PriceTable;
  /** 防跑飞。真实的停止条件是模型自己不再调工具 */
  readonly maxIterations?: number;
}

/*
 * ── 这里曾经有 `PermissionAnswer`（用户对一次 ask 的答复：effect × scope）──
 *
 * 连同 `TurnDeps.decide`（应答者）与 `TurnDeps.persistGrant`（把"永久允许"写回配置）
 * 一起删除（ADR-0039）。**注入一个应答者曾经是"这个闸门有没有出口"的开关**：
 * 不注入等于全部拒绝，注入一个恒 allow 的函数等于全部放行——headless 冒烟一直用的
 * 就是后者。现在没有出口这个概念了：判定的两个答案各自直接落地，不经过任何回调。
 */

interface PendingCall {
  readonly callId: CallId;
  readonly name: string;
  argsJson: string;
}

/** 最常见的输入形状：纯文字。多模态输入直接构造 ContentBlock[] 传给 runTurn */
export const textInput = (text: string): ContentBlock[] => [{ type: 'text', text }];

export async function runTurn(deps: TurnDeps, input: readonly ContentBlock[]): Promise<StopReason> {
  const { runtime } = deps;

  /*
   * 能力闸门必须在这里、在记第一条事件之前判。`turn.start` 一旦落库就必须有一条
   * `turn.end` 收尾配对（ADR-0008 的包含性不变量）；如果放任图片块流到 Provider
   * 深处才失败关闭，就会留下一条只有开始没有收尾的事件流。直接 throw，不新增
   * `StopReason` 枚举值——调用方（`services.sendUserMessage`）的 try/finally
   * 接得住，异常经 IPC 信封转成 `{ok:false}` 落进渲染层已有的错误态，不需要
   * 再造一条"被拒绝"的收尾语义。
   *
   * 只查*这一轮新输入*，不审计历史消息——中途换成不支持 vision 的模型、
   * 历史里却带着图片，仍然会在 Provider 深处报错。那是 M2 ContextBuilder
   * （预算/压缩）该管的事，见 ADR-0029 遗留。
   */
  const caps = deps.provider.capabilities(deps.model);
  if (input.some((b) => b.type === 'image') && !caps.vision) {
    throw new Error(
      `模型 ${deps.model} 不支持图片输入（vision），请换一个支持的模型或去掉图片后再试。`,
    );
  }
  if (input.some((b) => b.type === 'document') && !caps.documents) {
    throw new Error(`模型 ${deps.model} 不支持文档输入，请换一个支持的模型或去掉附件后再试。`);
  }

  /*
   * 8 太容易在正常任务里撞到——一个「做个 todolist」这种朴素任务，
   * 读文件、列目录、写几步、回头检查一下，往返次数很容易过 8。
   * 撞上限的后果不是"模型偷懒"，是回合被腰斩，用户看到的是任务莫名其妙半途而废。
   * 这里的上限本来就只是"防跑飞"的兜底，不是引导模型精简步骤的手段——
   * 收敛应该来自模型自己判断任务完成，不是靠一个悄悄的步数配额逼它提前结束。
   * 调大到 9999，实质上等于交给"模型自己不再调工具"这一条真正的停止条件；
   * 真正失控的死循环由用户手动停止 / 会话预算兜底，不该指望这个数字。
   */
  const maxIterations = deps.maxIterations ?? 9999;
  const turnId = newTurnId();

  // turn.start 自己就会把用户输入并进 messages（见 reduce.ts），别在这里再补一条 user 消息
  await runtime.record({
    type: 'turn.start',
    turnId,
    payload: { turnId, input: [...input] },
  });

  return driveTurnLoop(deps, turnId, maxIterations);
}

/**
 * 续跑一个已经开始、但因为进程崩溃而没跑完的回合（M1-e 崩溃恢复，docs/04 §8 步骤 3"继续"）。
 *
 * **调用方必须先用 `synthesizeInterruption()`（`crash-recovery.ts`）补完缺失的收尾事件**，
 * 这里不做——"要不要补、补哪些"是 `OrphanedTurn` 该回答的问题，这个函数只负责"从这里
 * 继续跑"，与 `runTurn()` 写完 `turn.start` 之后要做的事完全一样：下一步就是 `streamOnce`，
 * 效果等价于"崩溃发生的那个迭代边界之后，循环本来就会做的下一步"。不重连任何原生进程、
 * 不重放原始工具调用——模型只是被如实告知"这次没跑完"，这是没有幂等性契约时唯一安全
 * 的做法。`maxIterations` 重新计满：崩溃前用了几次不落库，这是可接受的近似。
 */
export async function resumeTurn(deps: TurnDeps, turnId: TurnId): Promise<StopReason> {
  return driveTurnLoop(deps, turnId, deps.maxIterations ?? 9999);
}

async function driveTurnLoop(deps: TurnDeps, turnId: TurnId, maxIterations: number): Promise<StopReason> {
  const { runtime } = deps;
  let reason: StopReason = 'end_turn';

  try {
    for (let i = 0; i < maxIterations; i++) {
      if (deps.signal?.aborted === true) {
        reason = 'aborted';
        break;
      }

      const { stopReason, calls } = await streamOnce(deps, turnId);
      reason = stopReason;

      if (calls.length === 0 || stopReason === 'aborted' || stopReason === 'error') break;

      for (const call of calls) {
        await dispatchCall(deps, turnId, call);
      }

      if (i === maxIterations - 1) {
        // 跑满上限而模型还在要工具：如实记下来，不要假装是正常结束
        await runtime.record({
          type: 'notice.posted',
          turnId,
          payload: {
            level: 'warn',
            code: 'turn.max_iterations',
            message: `本回合达到 ${String(maxIterations)} 次模型往返上限，已停止。`,
          },
        });
        reason = 'max_iterations';
      }
    }
  } finally {
    await runtime.record({ type: 'turn.end', turnId, payload: { turnId, reason } });
  }

  return reason;
}

// ── 一次模型往返 ─────────────────────────────────────────────────

interface StreamResult {
  readonly stopReason: StopReason;
  readonly calls: readonly PendingCall[];
}

async function streamOnce(deps: TurnDeps, turnId: TurnId): Promise<StreamResult> {
  const { runtime, provider } = deps;
  const messageId = newMessageId();

  await runtime.record({
    type: 'message.start',
    turnId,
    payload: { messageId, role: 'assistant', model: deps.model },
  });

  let text = '';
  let thinking = '';
  let thinkingSignature: string | undefined;
  let stopReason: StopReason = 'end_turn';
  const calls = new Map<CallId, PendingCall>();
  const order: CallId[] = [];

  const signal: AbortLike = deps.signal ?? NEVER_ABORTS;
  let failure: ReturnType<typeof xmError> | undefined;

  try {
    for await (const chunk of provider.stream(buildRequest(deps), signal)) {
      switch (chunk.kind) {
        case 'text_delta':
          text += chunk.text;
          // 瞬态：不落库、不占 seq，只推给订阅者。ADR-0008 的硬不变量是它不得携带
          // message.end 里不存在的信息——这里的 text 最后逐字进了 message.end
          await runtime.record({
            type: 'message.delta',
            turnId,
            payload: { messageId, blockIndex: 0, kind: 'text', text: chunk.text },
          });
          break;

        case 'thinking_delta':
          thinking += chunk.text;
          await runtime.record({
            type: 'message.delta',
            turnId,
            payload: { messageId, blockIndex: 0, kind: 'thinking', text: chunk.text },
          });
          break;

        case 'thinking_signature':
          thinkingSignature = chunk.signature;
          break;

        case 'tool_call_start':
          calls.set(chunk.id, { callId: chunk.id, name: chunk.name, argsJson: '' });
          order.push(chunk.id);
          break;

        case 'tool_call_delta': {
          const pending = calls.get(chunk.id);
          // 各家的分片边界不同，累积完整之后再一次性 parse 是唯一稳妥做法（contracts/model/chunk.ts）
          if (pending !== undefined) pending.argsJson += chunk.argsJson;
          break;
        }

        case 'tool_call_end':
          break;

        case 'usage': {
          // 成本由价格表算，Provider 不提供（contracts/model/usage.ts）
          const cost = costOf(chunk.usage, lookupPrice(deps.prices, provider.id, deps.model));
          await runtime.record({
            type: 'usage.recorded',
            turnId,
            payload: {
              turnId,
              provider: provider.id,
              model: deps.model,
              usage: chunk.usage,
              costUsd: cost ?? 0,
              priced: cost !== undefined,
            },
          });
          break;
        }

        case 'stop':
          stopReason = chunk.reason;
          break;
      }
    }
  } catch (e) {
    /*
     * Provider 抛错**不会跨越这里**。
     *
     * 让它往外抛看起来更"干净"，但那样这一段已经推给订阅者的 `message.delta`
     * 就再也不会有对应的 `message.end`——ADR-0008 的包含性不变量当场破掉，
     * 表现是用户看着打字机打出半句话，重开会话后那半句凭空消失。
     * 所以下面照常落 message.end（带已到达的部分），错误另记一条 error.raised。
     */
    failure = e instanceof Error ? xmError('provider_error', e.message) : xmError('internal', String(e));
    const asXm = (e as { xm?: unknown }).xm;
    if (isXmErrorLike(asXm)) failure = asXm;
    stopReason = failure.code === 'aborted' ? 'aborted' : 'error';
  }

  /*
   * 兜底：Provider 没守约定（取消时抛而不是干净收尾）时也要判对。
   *
   * 端口现在明写了「取消时正常结束迭代」，两个自家适配器都守。但这道兜底不能撤——
   * M3 的 MCP、M2 的子 Agent 都会带进不受我们控制的实现，而"取消被记成失败"
   * 是一个用户当场看得见的错。
   *
   * **`failure` 必须一并清掉。** 这是一次真调用照出来的 bug：真实 fetch 在 abort 时
   * 抛 `AbortError`，上面的 catch 把它记成 `provider_error`，这里只纠正了 stopReason
   * 而没动 failure——于是用户点了停止，却收到一条红色的 `error.raised`。
   * 单元测试没抓到，因为它只断言了两条事件**存在**，从没断言 error.raised **不存在**。
   */
  if (signal.aborted) {
    stopReason = 'aborted';
    failure = undefined;
  }

  const blocks: ContentBlock[] = [];
  if (thinking !== '') {
    blocks.push({
      type: 'thinking',
      text: thinking,
      ...(thinkingSignature === undefined ? {} : { signature: thinkingSignature }),
    });
  }
  if (text !== '') blocks.push({ type: 'text', text });
  for (const id of order) {
    const c = calls.get(id);
    if (c === undefined) continue;
    blocks.push({ type: 'tool_use', id: c.callId, name: c.name, input: parseArgs(c.argsJson) });
  }

  const message: Message = {
    id: messageId,
    role: 'assistant',
    blocks,
    model: deps.model,
    ts: Date.now(),
  };
  await runtime.record({ type: 'message.end', turnId, payload: { message } });

  /*
   * 中断是**两条事件**，不是一条。
   *
   * 直觉的写法是"中断时只发 message.interrupted"，但那样已经流出去的 delta
   * 在持久流里没有任何落点（见上面 catch 里的注释）。所以顺序是：
   *   message.end        —— 已到达的部分进 messages，模型下一轮看得见自己说到哪
   *   message.interrupted —— UI 据此标注"已停止"，live buffer 据此归零（ADR-0021）
   *
   * 反过来说，只发 message.end 也不行：那样这条被截断的回复看起来和一条正常回复
   * 完全一样，用户回看历史时无从分辨。
   */
  if (stopReason === 'aborted') {
    await runtime.record({
      type: 'message.interrupted',
      turnId,
      payload: { messageId, reason: 'aborted' },
    });
  }

  if (failure !== undefined && failure.code !== 'aborted') {
    await runtime.record({
      type: 'error.raised',
      turnId,
      // 一次模型调用失败不等于会话完蛋：用户可以改配置、换模型、重试
      payload: { error: failure, fatal: false },
    });
  }

  return { stopReason, calls: order.map((id) => calls.get(id)).filter(isPending) };
}

// ── 一次工具调用 ─────────────────────────────────────────────────

async function dispatchCall(deps: TurnDeps, turnId: TurnId, call: PendingCall): Promise<void> {
  const { runtime, tools } = deps;
  const tool = tools.get(call.name);

  if (tool === undefined) {
    await failCall(deps, turnId, call, xmError('tool_not_found', `没有名为 "${call.name}" 的工具。`));
    return;
  }

  /*
   * 入参**先校验、再解析、最后判权限**。这三步的顺序各有理由：
   *
   * 一、参数根本不合法的调用不该惊动用户。反过来的顺序会先发出 permission.request、
   *     弹一个审批框，等用户点了"允许"才在执行时因为 invalid_input 失败。
   *     审批噪音会直接转化成"下次顺手点允许"。
   * 二、判权用的必须是工具真正会执行的那个对象。工具 schema 允许 `.default()`
   *     （`.transform()` 被 assertToolSchema 禁掉了），于是原始 JSON 与校验后的值可能
   *     不是同一个东西——判定看着 A、执行的是 B，就是权限判定上的 TOCTOU。
   * 三、同理，网关解析路径之后**必须回写入参**：判定看到 realpath 之后的绝对路径，
   *     执行却拿着模型给的那个符号链接，等于判定判了个别的东西（ADR-0024）。
   */
  let input: unknown;
  try {
    input = tool.parseInput(parseArgs(call.argsJson));
  } catch (e) {
    await failCall(
      deps,
      turnId,
      call,
      e instanceof ToolInputError
        ? e.asXmError
        : xmError('invalid_input', e instanceof Error ? e.message : String(e)),
    );
    return;
  }

  let ctx: ToolContext = {
    sessionId: runtime.sessionId,
    signal: deps.signal ?? NEVER_ABORTS,
    cwd: runtime.state.cwd,
    executor: 'local',
  };

  let claims = claimsOfCapabilities(tool.descriptor.capabilities, '');
  if (deps.gateway !== undefined) {
    try {
      const resolved = await deps.gateway.resolve(tool, input, ctx);
      input = resolved.input;
      claims = resolved.claims;
      /*
       * 网络侧"判定与执行必须共用同一个值"的载体（M1-d）：网关那次 DNS 解析出的地址
       * 原样交给执行阶段。工具建连时只能用这张表里的地址，不能自己再解析一次——
       * 那会重新打开 DNS rebinding 的窗口（见 `ToolContext.pinnedHosts` 的注释）。
       */
      if (resolved.pinnedHosts !== undefined) ctx = { ...ctx, pinnedHosts: resolved.pinnedHosts };
    } catch (e) {
      // 失败关闭：解析不了就不执行，也**不发权限事件**——没有解析出来的目标，
      // 弹给用户看的那个确认框上写什么都是猜的
      await failCall(
        deps,
        turnId,
        call,
        e instanceof GatewayError
          ? e.asXmError
          : xmError('invalid_input', e instanceof Error ? e.message : String(e)),
      );
      return;
    }
  }

  /*
   * 信任级别是**算出来的，不是填的**。
   *
   * 它此前在这里被硬编码成 `'model'`，而那是唯一的赋值点——于是整套注入降级
   * （allow→ask、ask→deny）与三条 `red.*-untrusted` 红线从写下起一次也没触发过。
   * 现在它来自事件流：本会话跑过带 `net.fetch` / `browser.control` / `gui.capture`
   * 的工具之后，`untrustedContext` 就被置上，此后所有判定按不可信走（reduce.ts）。
   */
  const trustLevel = deps.runtime.state.untrustedContext === undefined ? 'model' : 'untrusted';

  /*
   * `trustLevel` 是判定需要从 `untrustedContext` 里知道的**全部**信息。
   *
   * 这里曾经还取两个字段传给 `evaluate()`：`untrustedSince` 与 `untrustedCallId`，
   * 用来判断一条会话授权是不是"用户看着不可信横幅、针对这个目标当场点的"
   * （ADR-0034/0035 的知情授权）。没有会话授权之后它们没有了消费者——
   * 污染的时刻与出处仍然留在 `SessionState.untrustedContext` 里给 UI 说人话用，
   * 只是不再参与判定。
   */

  /*
   * 权限闸门。**必须在执行之前，且没有旁路。**
   *
   * 判的是**主张**（`PermissionClaim`），不是"工具声明的能力 × 一个 target"。
   * 一条 `rm -rf ~` 同时主张「执行一条命令」和「删除 /home/ming」，
   * 后者撞的是一条 M0 就写好的红线（ADR-0026）。
   *
   * 任一主张被拒即整体拒绝——取最严的那个。反过来（任一放行即放行）会让
   * "既主张 fs.read 又主张 fs.delete 的调用"靠 fs.read 蒙混过关。
   */
  const missing = tool.descriptor.capabilities.filter(
    (c) => !claims.some((claim) => claim.capability === c),
  );
  if (missing.length > 0) {
    /*
     * **主张只能加不能减。** 少一条主张，就意味着这次调用可以绕过它自己声明的能力——
     * 而这道断言之所以在这里而不是在网关里，是因为网关有好几个实现（Node、pure、
     * 将来的容器执行器），而这条不变量对每一个都必须成立。
     */
    await failCall(
      deps,
      turnId,
      call,
      xmError(
        'invalid_input',
        `工具 ${call.name} 声明了能力「${missing.join('、')}」，` +
          `但网关没有为它产出对应的主张。这会让针对这些能力的规则整体失效，因此拒绝执行。`,
      ),
    );
    return;
  }

  const requestOf = (claim: PermissionClaim): PermissionRequest => ({
    requestId: newRequestId(),
    sessionId: runtime.sessionId,
    callId: call.callId,
    capability: claim.capability,
    target: claim.target,
    risk: tool.descriptor.risk,
    reason: `工具 ${call.name} 需要「${claim.capability}」`,
    trustLevel,
  });

  const judge = (request: PermissionRequest): PolicyVerdict =>
    evaluate({
      request,
      layers: deps.layers,
      ...(deps.pathCaseInsensitive === undefined
        ? {}
        : { pathCaseInsensitive: deps.pathCaseInsensitive }),
    });

  /*
   * ── 判完全部主张，任一 deny 即整体拒绝 ──
   *
   * ADR-0039 之前这里是两个循环：先把全部主张判一遍，再回头逐条去问用户。
   * 分成两趟是为了避免"第 1 条弹框、用户点了允许、第 2 条 deny"这种为一次注定失败的
   * 调用做决定的体验，而且第二趟里 request 事件必须紧挨着自己的 decision 发出，
   * 否则 `pendingPermission` 那个单槽位会被下一条 request 顶掉，用户点了没反应。
   *
   * 现在只剩一趟：没有人要问，deny 直接结束这次调用。
   *
   * 每条 deny 仍然成对记下 `permission.request` + `permission.decision`
   * （`by: 'policy'`）——它不再驱动任何 UI，纯粹是审计：用户问"为什么拦我"，
   * 答案要能精确到 ruleId。事件流里从此不会出现 `by: 'user'` 的 decision。
   */
  for (const claim of claims) {
    const request = requestOf(claim);
    const verdict = judge(request);
    if (verdict.effect === 'allow') continue;

    await runtime.record({
      type: 'permission.request',
      turnId,
      payload: {
        requestId: request.requestId,
        callId: call.callId,
        capability: request.capability,
        target: request.target,
        risk: request.risk,
        reason: verdict.reason,
        trustLevel,
      },
    });
    await runtime.record({
      type: 'permission.decision',
      turnId,
      payload: {
        requestId: request.requestId,
        effect: 'deny',
        scope: 'once',
        by: 'policy',
        ruleId: verdict.ruleId,
      },
    });
    await failCall(deps, turnId, call, xmError('policy_denied', verdict.reason));
    return;
  }

  await executeCall(deps, turnId, call, tool, input, ctx, claims);
}

/*
 * ── 这里曾经有 `decideOrAbort()` 与 `persistAlways()` ──
 *
 * 前者等用户应答、同时盯着取消信号：一个挂起的审批就是一个挂起的 promise，
 * `AbortController` 唤不醒它，于是"点了停止但界面一直在转"的完整条件是某个应答者
 * 忘了在中断时兑现。那道保险必须长在这里而不是写成对每个应答者的要求——
 * 桌面 UI、headless 注入的函数、将来的 CLI、M3 的插件宿主，每一个都记得处理取消
 * 是一条迟早会被漏掉的约定。
 *
 * 后者把「永久允许」写回用户级配置，并在写不成时降级成"只在本会话生效"并落一条
 * notice——**退化必须是用户看得见的**。
 *
 * ADR-0039 之后，"挂起等人"这件事在结构上不存在了，两个函数与它们各自防的那个坑
 * 一起消失。取消路径因此简单了一截：runTurn 里唯一还会长时间挂着的是模型流与工具执行，
 * 两者都有自己的 abort 处理。
 */

async function executeCall(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
  tool: RegisteredTool,
  input: unknown,
  ctx: ToolContext,
  claims: readonly PermissionClaim[],
): Promise<void> {
  const { runtime } = deps;
  const startedAt = Date.now();

  await recordCheckpoint(deps, turnId, tool, input, ctx, claims);

  await runtime.record({
    type: 'tool.start',
    turnId,
    payload: {
      callId: call.callId,
      messageId: newMessageId(),
      name: call.name,
      input,
      risk: tool.descriptor.risk,
      /*
       * 记的是**主张里的能力全集**，不是工具静态声明的那几个。
       *
       * 这一行是"用 shell 跑 curl"不再绕过注入防御的全部原因：`untrustedContext`
       * 由 `reduce` 从这个字段算出来（`taintOf`），而 `shell.exec` 静态声明的
       * 只有 `shell.exec` 一个。不改这里，一条 `curl` 命令带回来的网页内容
       * 就是"进了上下文却没被标记"的——整套 allow→ask、ask→deny 从此对它失效。
       */
      capabilities: [...new Set(claims.map((c) => c.capability))],
    },
  });

  let forModel: ResultBlock[] = [];
  let error: ReturnType<typeof xmError> | undefined;

  try {
    for await (const progress of tool.execute(input, ctx)) {
      if (progress.kind === 'progress') {
        await runtime.record({
          type: 'tool.progress',
          turnId,
          payload: {
            callId: call.callId,
            ...(progress.message === undefined ? {} : { message: progress.message }),
            ...(progress.data === undefined ? {} : { data: progress.data }),
          },
        });
      } else {
        forModel = [...progress.forModel];
      }
    }
  } catch (e) {
    /*
     * 工具失败**不跨越主循环抛出**（contracts/base/error.ts）：转成 isError 的结果回灌，
     * 模型有机会换个方式重试。这是 Agent 能力的重要来源，也是"一次工具失败不该
     * 让整个会话死掉"的具体实现。
     */
    error =
      e instanceof ToolInputError
        ? xmError('invalid_input', e.message)
        : xmError('internal', e instanceof Error ? e.message : String(e));
    forModel = [{ type: 'text', text: error.message }];
  }

  const capped = await capResult(deps, forModel, tool);

  await runtime.record({
    type: 'tool.end',
    turnId,
    payload: {
      callId: call.callId,
      ok: error === undefined,
      durationMs: Date.now() - startedAt,
      forModel: capped.forModel,
      ...(capped.fullRef === undefined ? {} : { fullRef: capped.fullRef }),
      ...(error === undefined ? {} : { error }),
    },
  });
}

/**
 * 结果截断 —— **由运行时统一执行，不由工具自觉**（ADR-0009）。
 *
 * `truncateResult` 与它的 12 条用例从 M0-a 起就在内核里，但**没有任何调用点**：
 * 玩具工具的输出都是几十个字节，接上真实的 `fs.read` 之前谁也不会发现。
 * 这个函数就是那个缺失的调用点——本项目第 N 次「实现存在 ≠ 实现生效」。
 *
 * 先不带 ref 截一次、只有真截断了才写 blob，是为了让绝大多数小结果一次盘都不落。
 * `truncateResult` 是纯函数，重算没有副作用。
 */
async function capResult(
  deps: TurnDeps,
  blocks: readonly ResultBlock[],
  tool: RegisteredTool,
): Promise<{ forModel: ResultBlock[]; fullRef?: BlobRef }> {
  const limits = tool.descriptor.resultLimits;
  const probe = truncateResult(blocks, limits);
  if (!probe.truncated) return { forModel: probe.blocks };

  if (deps.blobs === undefined) {
    /*
     * 没有 blob 存储：**照样截断**，只是标记里没有"完整内容在哪"。
     *
     * 反过来（没地方存全文就不截断）会让 headless 与测试环境的行为与生产不同，
     * 而截断恰恰是那种"只在生产的大文件上才出问题"的东西。
     */
    return { forModel: probe.blocks };
  }

  const full = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const ref = await deps.blobs.put(new TextEncoder().encode(full), 'text/plain');
  return { forModel: truncateResult(blocks, limits, ref).blocks, fullRef: ref };
}

/**
 * 写前还原点（ADR-0003「无条件还原点」的执行点）。
 *
 * **快照失败不中止执行**，只落一条 notice。取舍的理由：用户要的是把活干完，
 * 而一次快照失败（磁盘满、文件太大）不该让任务停下——但他必须知道"这一步没有退路"，
 * 否则他会按"反正能撤销"的心态继续往下走。
 */
async function recordCheckpoint(
  deps: TurnDeps,
  turnId: TurnId,
  tool: RegisteredTool,
  input: unknown,
  ctx: ToolContext,
  claims: readonly PermissionClaim[],
): Promise<void> {
  if (deps.checkpointer === undefined) return;

  try {
    const record = await deps.checkpointer.before(tool, input, ctx, claims);
    if (record === undefined) return;
    await deps.runtime.record({
      type: 'checkpoint.created',
      turnId,
      payload: {
        checkpointId: newCheckpointId(),
        kind: record.kind,
        ref: record.ref,
        label: record.label,
      },
    });
  } catch (e) {
    await deps.runtime.record({
      type: 'notice.posted',
      turnId,
      payload: {
        level: 'warn',
        code: 'checkpoint.failed',
        message:
          `没能为 ${tool.descriptor.name} 建立还原点，**这一步无法撤销**：` +
          (e instanceof Error ? e.message : String(e)),
      },
    });
  }
}

/** 未执行就结束的调用：仍然要产出 tool.end，否则模型收不到这次 tool_use 的结果 */
async function failCall(
  deps: TurnDeps,
  turnId: TurnId,
  call: PendingCall,
  error: ReturnType<typeof xmError>,
): Promise<void> {
  await deps.runtime.record({
    type: 'tool.end',
    turnId,
    payload: {
      callId: call.callId,
      ok: false,
      durationMs: 0,
      forModel: [{ type: 'text', text: error.message }],
      error,
    },
  });
}

// ── 小工具 ──────────────────────────────────────────────────────

function buildRequest(deps: TurnDeps): ModelRequest {
  return {
    model: deps.model,
    // M0-b 没有 ContextBuilder：system 是空的，messages 直接取状态里的全量。
    // 预算分配、分层压缩、缓存断点都是 M2（ADR-0006），别在这里长出一个半成品。
    system: [],
    messages: [...deps.runtime.state.messages],
    tools: deps.tools.descriptors(),
    maxOutputTokens: 128_000,
  };
}

/** 模型给的参数 JSON 可能是残缺的。解析不了就交给工具的 strict parse 去报 invalid_input */
function parseArgs(argsJson: string): unknown {
  if (argsJson.trim() === '') return {};
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return {};
  }
}

const isPending = (c: PendingCall | undefined): c is PendingCall => c !== undefined;

/**
 * Provider 抛的错里若挂着结构化 `XmError`（`ProviderHttpError.xm`），原样用它。
 *
 * 用结构判断而不是 `instanceof`：runtime 不依赖 `@xm/providers`（依赖方向是
 * apps 装配时才把两者接上），拿不到那个类。而这里要的信息只是"有没有 code"。
 */
function isXmErrorLike(v: unknown): v is ReturnType<typeof xmError> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { code?: unknown }).code === 'string' &&
    typeof (v as { message?: unknown }).message === 'string'
  );
}

const NEVER_ABORTS: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

export type { CallId, MessageId };
