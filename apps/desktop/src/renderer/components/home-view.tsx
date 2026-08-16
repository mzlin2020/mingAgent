import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './ui.js';
import { SessionStatusBadge } from './session-status.js';
import { cn } from '../lib/cn.js';
import { CHAT_COLUMN } from '../lib/layout.js';
import { formatRelativeTime } from '../lib/relative-time.js';
import { useUi } from '../store.js';

/**
 * Home：最近会话（按 listSessions 的 updatedAt 倒序，服务端已排好）。
 * 不展示 cwd / 项目列（ADR-0037）。
 *
 * 这不是会话空态。新会话（零消息）走对话列里的 hero 输入卡，两者在 M3.5-c 拆开。
 */
export function HomeView(): ReactNode {
  const sessions = useUi((s) => s.sessions);
  const openSession = useUi((s) => s.openSession);
  const newSession = useUi((s) => s.newSession);
  const chooseWorkspace = useUi((s) => s.chooseWorkspace);

  /*
    相对时间要自己走针。只在渲染时取一次 `Date.now()` 的话，用户在 Home 上停留几分钟，
    一条"刚刚"就会一直是"刚刚"——那是这个仓库反复在防的那种错误：一个自信的错数字
    比不显示更糟。半分钟一跳，跟最小档位（分钟）对得上；HomeView 只在 Home 挂载，
    离开就清掉，不会在后台空转。
  */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <div className={cn(CHAT_COLUMN, 'flex flex-col gap-7 py-12')}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-semibold tracking-tight">最近会话</h1>
          <p className="mt-1.5 text-meta text-muted">按最近活动排序。关闭标签不会删除会话。</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void chooseWorkspace().then((cwd) =>
                cwd === undefined ? undefined : newSession(cwd),
              );
            }}
          >
            <FolderIcon />
            从目录创建
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void newSession();
            }}
          >
            <PlusIcon />
            新建会话
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-16 text-center text-meta text-muted">
          还没有会话。新建一个开始。
        </p>
      ) : (
        <ul className="flex flex-col">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                type="button"
                onClick={() => {
                  void openSession(s.sessionId);
                }}
                className={cn(
                  'flex w-full items-center rounded-control px-3 py-3 text-left text-body',
                  'text-fg transition-colors hover:bg-surface',
                )}
              >
                {/*
                  状态徽标跟着标题走、不跟着时间走：它说的是"这个会话现在怎么样"，
                  属于名字那一侧（顶栏 tabs 也是这么排的）。放在右边会把时间列挤得参差不齐——
                  有徽标的行和没徽标的行，时间落在两个不同的位置上。
                */}
                <span className="flex min-w-0 flex-1 items-center">
                  <span className="truncate">
                    {s.title === '' || s.title === undefined ? '未命名' : s.title}
                  </span>
                  <SessionStatusBadge status={s.status} />
                </span>
                {/*
                  相对时间落这一列（ADR-0037 把"Home 无 cwd、同名会话难辨"记成负面，
                  并写明缓解手段是"可后续加相对时间或 cwd"）。它同时让标题下面那句
                  "按最近活动排序"变成可核对的——否则用户只能选择相信。
                  绝对时间放 title：判断"是不是我刚才那条"偶尔需要精确到分钟。
                */}
                <time
                  dateTime={new Date(s.updatedAt).toISOString()}
                  title={new Date(s.updatedAt).toLocaleString()}
                  className="ml-4 shrink-0 text-micro tabular-nums text-faint"
                >
                  {formatRelativeTime(s.updatedAt, now)}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlusIcon(): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function FolderIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
