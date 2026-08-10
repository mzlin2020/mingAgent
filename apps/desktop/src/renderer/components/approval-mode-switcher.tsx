import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ApprovalMode } from '../../shared/ipc.js';
import { Button, Card } from './ui.js';
import { useUi } from '../store.js';

/**
 * 审批模式切换（docs/09 C6，ADR-0030）。
 *
 * ── 为什么常驻在头部，不是藏进设置页 ──
 *
 * 这个功能要解决的是"整段时间的心智负担"，不是某一次操作的确认。用户必须随时
 * 能看到自己现在开的是哪一档——尤其在"帮我批准"/"完全访问权限"下 `PermissionCard`
 * 几乎不会再出现，界面上唯一提醒他"权限比平时松"的就是这里。
 *
 * ── "完全访问权限"为什么要点两次 ──
 *
 * 它与"帮我批准"在判定机制上完全相同（都映射到已经过 ADR-0017/C5 验证过的 YOLO
 * 语义：跳过 `ask`，红线与任何 `deny` 原样生效，ADR-0030），区别只在开启门槛与
 * 文案。选中它不会立刻生效，而是先内联展开一段警告 + 一个"确认开启"按钮
 * （跟 `PermissionCard`/`UntrustedBanner` 一样，不用模态框）——讲清楚"完全"指的是
 * "不再问你"而不是"没有底线"，避免用户以为开了这个开关就真的没有任何保护。
 */
export function ApprovalModeSwitcher(): ReactNode {
  const mode = useUi((s) => s.approvalMode);
  const setMode = useUi((s) => s.setApprovalMode);
  const [confirmingFull, setConfirmingFull] = useState(false);

  const options: readonly { readonly value: ApprovalMode; readonly label: string }[] = [
    { value: 'ask', label: '请求批准' },
    { value: 'auto', label: '帮我批准' },
    { value: 'full', label: '完全访问权限' },
  ];

  const pick = (value: ApprovalMode): void => {
    if (value === 'full') {
      setConfirmingFull(true);
      return;
    }
    setConfirmingFull(false);
    void setMode(value);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-0.5 rounded-md border border-[var(--xm-border)] p-0.5">
        {options.map((o) => (
          <Button
            key={o.value}
            variant={mode === o.value ? 'default' : 'ghost'}
            className="px-2 py-1 text-xs"
            onClick={() => {
              pick(o.value);
            }}
          >
            {o.label}
          </Button>
        ))}
      </div>

      {confirmingFull && (
        <Card className="absolute right-0 z-10 mt-2 w-72 border-[var(--xm-danger)]">
          <p className="font-medium">确认开启完全访问权限？</p>
          <p className="mt-1 text-xs text-[var(--xm-fg-muted)]">
            开启后不会再向你确认任何操作，包括执行命令、删除文件、访问网络。
            <b>读过网页之后的提示词注入防御也会一并放宽</b>：网页里的内容说服小明去访问
            某个网址、删掉某个文件，都不会再弹框——只有推送到远端、安装依赖、修改系统设置
            这三类仍然会问你一次。 红线（如禁止删除主目录、禁止读取密钥、禁止修改小明自身
            判权逻辑）和你自己写的拒绝规则仍然生效，作为最后一道保险。
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => {
                setConfirmingFull(false);
                void setMode('full');
              }}
            >
              确认开启
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmingFull(false);
              }}
            >
              取消
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
