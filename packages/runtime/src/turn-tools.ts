import type {
  PermissionRequest,
  PolicyVerdict,
  ResultBlock,
  TurnId,
} from '@xm/contracts';
import { newMessageId, newRequestId, xmError } from '@xm/contracts';
import type {
  AbortLike,
  PermissionClaim,
  RegisteredTool,
  ToolContext,
} from '@xm/kernel';
import {
  GatewayError,
  ToolInputError,
  claimsOfCapabilities,
  evaluate,
} from '@xm/kernel';
import { recordTurnCheckpoint } from './turn-checkpoint.js';
import { turnAvailabilityContext } from './turn-request.js';
import { capToolResult } from './turn-result.js';
import type { PendingCall, TurnDeps } from './turn-types.js';

export async function dispatchCall(deps: TurnDeps, turnId: TurnId, call: PendingCall): Promise<void> {
  const { runtime, tools } = deps;
  const availability = turnAvailabilityContext(deps);
  const tool =
    availability === undefined
      ? tools.get(call.name)
      : tools.getAvailable(call.name, availability);

  if (tool === undefined) {
    await failCall(
      deps,
      turnId,
      call,
      tools.has(call.name)
        ? xmError('unsupported', `工具 "${call.name}" 已被配置禁用或当前平台不可用。`)
        : xmError('tool_not_found', `没有名为 "${call.name}" 的工具。`),
    );
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
    callId: call.callId,
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

  try {
    await recordTurnCheckpoint(deps, turnId, call.callId, tool, input, ctx, claims);
  } catch (e) {
    await failCall(
      deps,
      turnId,
      call,
      xmError(
        'executor_failed',
        `无法安全执行 ${tool.descriptor.name}：写前还原点创建失败，操作已停止。${e instanceof Error ? e.message : String(e)}`,
        { retryable: true },
      ),
    );
    return;
  }

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

  const capped = await capToolResult(deps, forModel, tool);

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

function parseArgs(argsJson: string): unknown {
  if (argsJson.trim() === '') return {};
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return {};
  }
}

const NEVER_ABORTS: AbortLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
