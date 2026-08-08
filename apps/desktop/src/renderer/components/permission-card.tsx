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
 */
export function PermissionCard(): ReactNode {
  const request = useUi((s) => s.session?.pendingPermission);
  const respond = useUi((s) => s.respondPermission);
  if (request === undefined) return null;

  const answer = (effect: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => () => {
    void respond(request.requestId, effect, scope);
  };

  return (
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
        <dt className="text-[var(--xm-fg-muted)]">{request.capability.startsWith('shell.') ? '命令' : '目标'}</dt>
        <dd className="break-all font-mono">{request.target === '' ? '（无）' : request.target}</dd>
        <dt className="text-[var(--xm-fg-muted)]">风险</dt>
        <dd>{request.risk}</dd>
        <dt className="text-[var(--xm-fg-muted)]">原因</dt>
        <dd>{request.reason}</dd>
      </dl>

      {request.trustLevel === 'untrusted' && (
        <p className="mt-2 rounded bg-[var(--xm-danger-bg)] px-2 py-1 text-xs">
          本会话读过外部内容。请特别确认这次操作确实是你要的。
        </p>
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
  );
}
