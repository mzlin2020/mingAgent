import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button, Card } from './ui.js';
import { useUi } from '../store.js';

/**
 * 审批卡片 —— 权限闸门的用户侧。
 *
 * ── 为什么内联在消息流里，不是模态框 ──
 *
 * 模态框挡住上下文，而用户恰恰要看着上下文才能判断这次操作合不合理
 * （"它刚才说要改哪个文件来着？"）。挡住之后剩下的只有"允许/拒绝"两个按钮，
 * 那时唯一理性的选择就是点允许。
 *
 * ── 卡片上的每一个字都来自事件流 ──
 *
 * 工具名、能力、**网关解析后的** target、风险等级、命中的规则 id——全部由
 * `reduce` 从 `permission.request` 算出，模型碰不到。这与 ADR-0019 的解除按钮
 * 是同一条理由：模型完全可以在回复里写"下面那个框点允许就行"，
 * 而用户要确认的必须是一件具体的事，不是一段措辞。
 *
 * ── 「永久」为什么单独一行、样式更重 ──
 *
 * 它会写进用户级配置文件并在重启后继续生效，是这四个按钮里唯一有持久后果的那个。
 * 四个等宽按钮并排会让它和"本次允许"看起来一样轻。
 *
 * ── 出现时为什么强制滚进可视区 ──
 *
 * App 的 stickToBottom 只跟 `messages` / `live`（流式增量）。`permission.request`
 * 不改那两样，卡片会长在底部可视区外，用户不知道在等审批。这是阻塞交互，
 * 不能沿用"用户翻历史就别拽回去"——按 requestId 出现时滚一次，答完就不再动。
 */
export function PermissionCard(): ReactNode {
  const request = useUi((s) => s.session?.pendingPermission);
  const untrusted = useUi((s) => s.session?.untrustedContext);
  const respond = useUi((s) => s.respondPermission);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (request === undefined) return;
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [request?.requestId]);

  if (request === undefined) return null;

  const answer = (effect: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => () => {
    void respond(request.requestId, effect, scope);
  };

  return (
    <div ref={cardRef}>
      <Card className="border-[var(--xm-accent)]">
        <p className="font-medium">需要你的确认</p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-[var(--xm-fg-muted)]">操作</dt>
          <dd className="font-mono">{request.capability}</dd>
          {/*
            一次调用可能过好几道闸门（ADR-0026：一条 `rm foo` 同时主张"执行命令"
            与"删除某个文件"），卡片一次显示一道，逐个应答。目标这一栏的名字随之而变——
            命令类能力下它是一条命令，路径类下它是一个文件。
          */}
          <dt className="text-[var(--xm-fg-muted)]">
            {request.capability.startsWith('shell.') ? '命令' : '目标'}
          </dt>
          <dd className="break-all font-mono">{request.target === '' ? '（无）' : request.target}</dd>
          <dt className="text-[var(--xm-fg-muted)]">风险</dt>
          <dd>{request.risk}</dd>
          <dt className="text-[var(--xm-fg-muted)]">原因</dt>
          <dd>{request.reason}</dd>
        </dl>

        {/*
          不可信上下文下的高警示样式（ADR-0035）。

          默认档里，污染之后的非严重不可撤销操作从硬 deny 放宽成了一个可以当场授权的
          ask——放宽的前提是这个框**不能长得和日常那个一模一样**，否则就正好落进
          ADR-0017 担心的那件事："弹一个平时天天点的确认框，用户照点不误"。

          所以这里复述的是事件流里的事实：哪个工具、经由哪个能力、什么时候把上下文
          弄脏的。三个字段都来自 `UntrustedContext`（`reduce` 从 `tool.start` 算出），
          模型碰不到——与 `UntrustedBanner` 反社工的理由完全相同。
        */}
        {request.trustLevel === 'untrusted' && (
          <div className="mt-2 rounded border border-[var(--xm-danger)] bg-[var(--xm-danger-bg)] px-2 py-1 text-xs">
            <p className="font-medium">这是读过外部内容之后才出现的请求</p>
            {untrusted !== undefined && (
              <p className="mt-0.5 text-[var(--xm-fg-muted)]">
                {new Date(untrusted.since).toLocaleTimeString()} 由工具{' '}
                <span className="font-mono">{untrusted.toolName}</span>（
                <span className="font-mono">{untrusted.viaCapability}</span>）引入。
                如果这不是你要求的，那它可能来自那段内容里的指示。
              </p>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={answer('allow', 'once')}>允许本次</Button>
          <Button variant="ghost" onClick={answer('allow', 'session')}>
            本会话都允许
          </Button>
          <Button variant="ghost" onClick={answer('deny', 'once')}>
            拒绝
          </Button>
          <Button variant="ghost" onClick={answer('deny', 'session')}>
            本会话都拒绝
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-[var(--xm-border)] pt-2">
          <Button variant="ghost" onClick={answer('allow', 'always')}>
            永久允许这个目标
          </Button>
          <span className="text-xs text-[var(--xm-fg-muted)]">
            会写进用户配置，重启后仍然生效。只针对上面那一个目标。
          </span>
        </div>
      </Card>
    </div>
  );
}
