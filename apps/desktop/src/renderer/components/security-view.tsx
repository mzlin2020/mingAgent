import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { COLUMN } from '../lib/layout.js';
import { useUi } from '../store.js';

export function SecurityView(): ReactNode {
  const status = useUi((state) => state.status);
  const security = status?.security;
  return (
    <main className={cn(COLUMN, 'py-8')}>
      <h1 className="text-title text-fg">设置与安全</h1>
      <p className="mt-2 text-body text-muted">当前边界：主机范围自主 + 核心资源保护。这不是工作区或操作系统沙箱。</p>
      <div className="mt-6 rounded-card border border-danger-border bg-danger-bg p-4 text-body text-danger">
        重要限制：任意本机子进程不受 OS 文件沙箱保护；内建工具与可分析命令只受策略边界约束。
      </div>
      {security === undefined ? <p className="mt-6 text-body text-muted">正在读取安全状态……</p> : (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Section title="不可覆盖保护" items={security.protectedResources} />
          <Section title="已启用工具" items={security.enabledTools} />
          <Section title="配置禁用工具" items={security.disabledTools} />
          <Section title="当前平台不可用工具" items={security.unavailableTools} />
          <section className="rounded-card border border-border bg-surface p-4">
            <h2 className="text-body font-semibold">终端与日志</h2>
            <p className="mt-2 text-meta text-muted">PTY：受控 argv 模式，无原始 stdin，不支持 REPL、vim 或全屏交互。</p>
            <p className="mt-2 text-meta text-muted">日志脱敏：已启用；密钥后端：{status?.secretBackend ?? '未知'}。</p>
          </section>
          <Section title="配置问题" items={(status?.configProblems ?? []).map((problem) => `${problem.code}：${problem.message}`)} empty="未发现" />
        </div>
      )}
    </main>
  );
}

function Section({ title, items, empty = '无' }: { readonly title: string; readonly items: readonly string[]; readonly empty?: string }): ReactNode {
  return <section className="rounded-card border border-border bg-surface p-4"><h2 className="text-body font-semibold">{title}</h2>{items.length === 0 ? <p className="mt-2 text-meta text-muted">{empty}</p> : <ul className="mt-2 list-disc space-y-1 pl-5 text-meta text-muted">{items.map((item) => <li key={item}>{item}</li>)}</ul>}</section>;
}
