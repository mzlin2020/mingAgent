import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button, Card } from './ui.js';

export function SettingsSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section>
      <h2 className="text-body font-semibold">{title}</h2>
      <p className="mt-1 text-meta text-muted">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SettingsNotice({
  children,
  tone = 'default',
}: {
  readonly children: ReactNode;
  readonly tone?: 'default' | 'danger';
}): ReactNode {
  return (
    <div
      className={cn(
        'rounded-card border px-3 py-2 text-meta',
        tone === 'danger' ? 'border-danger-border bg-danger-bg text-danger' : 'border-border bg-surface text-muted',
      )}
    >
      {children}
    </div>
  );
}

export function ChoiceCard({
  selected,
  title,
  detail,
  warning,
  onSelect,
}: {
  readonly selected: boolean;
  readonly title: string;
  readonly detail: string;
  readonly warning?: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'rounded-card border p-3 text-left',
        selected ? 'border-accent bg-accent-weak' : 'border-border bg-surface hover:border-border-strong',
      )}
    >
      <span className="font-medium">{title}</span>
      {warning === true && <span className="ml-2 text-micro text-danger">不推荐</span>}
      <span className="mt-1 block text-meta text-muted">{detail}</span>
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <label className="block">
      <span className="text-meta text-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {hint !== undefined && <span className="mt-1 block text-micro text-faint">{hint}</span>}
    </label>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled = false,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: 'text' | 'password' | 'url';
  readonly disabled?: boolean;
}): ReactNode {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => { onChange(event.target.value); }}
      className={cn(
        'h-9 w-full rounded-control border border-border bg-surface px-3 text-body',
        'outline-none placeholder:text-faint focus:border-accent',
        disabled && 'cursor-not-allowed opacity-45',
      )}
    />
  );
}

export function SettingsSaveBar({
  dirty,
  saving,
  onSave,
}: {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onSave: () => void;
}): ReactNode {
  return (
    <div className="flex justify-end">
      <Button disabled={!dirty || saving} onClick={onSave}>
        {saving ? '保存中…' : '保存'}
      </Button>
    </div>
  );
}

export { Card, Button };
