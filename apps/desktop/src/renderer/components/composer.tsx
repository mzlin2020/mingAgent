import { useState } from 'react';
import type { ClipboardEvent, ReactNode } from 'react';
import type { ImageAttachment } from '../../shared/ipc.js';
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_RAW_BYTES } from '../../shared/ipc.js';
import { Button, Textarea } from './ui.js';
import { cn } from '../lib/cn.js';
import { useUi } from '../store.js';

/**
 * 输入区。跑起来之后发送按钮**变成**停止按钮，不是并排多一个。
 *
 * 并排两个按钮意味着"发送"在跑动期间是可点的，那要么排队要么静默丢弃——
 * 两种都会让用户以为第二条消息生效了。原地替换的语义没有歧义：
 * 这一刻要么能发，要么能停。
 *
 * 一体式外壳：边框与焦点色包住整块（缩略图 + 文本 + 操作），按钮在右下角；
 * 外壳的圆角 / 边框 / 焦点色与 `Textarea`/`Card` 同一套 token，不另起视觉语言。
 */
/** 待发送的一张图。`previewUrl` 就是完整的 data URL，缩略图直接用它，不用另起一次读取 */
interface PendingImage {
  readonly data: string;
  readonly mime: string;
  readonly name?: string;
  readonly previewUrl: string;
}

function SendIcon(): ReactNode {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4z" />
    </svg>
  );
}

function StopIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function Composer({ disabled, running }: { readonly disabled: boolean; readonly running: boolean }): ReactNode {
  const send = useUi((s) => s.send);
  const stop = useUi((s) => s.stop);
  const [text, setText] = useState('');
  const [images, setImages] = useState<readonly PendingImage[]>([]);
  const [attachError, setAttachError] = useState<string | undefined>(undefined);

  /*
   * 这个仓库第一处粘贴/文件处理代码，没有旧模式可抄。张数与大小先在这里挡一遍——
   * 真正的强制校验仍然在主进程（IPC 不信任渲染层），这里只是不让用户白等一次网络往返
   * 才发现图片太大。
   */
  const addFile = (file: File): void => {
    if (images.length >= MAX_IMAGES_PER_MESSAGE) {
      setAttachError(`一条消息最多贴 ${String(MAX_IMAGES_PER_MESSAGE)} 张图。`);
      return;
    }
    if (file.size > MAX_IMAGE_RAW_BYTES) {
      setAttachError(`"${file.name}" 超过单图 ${String(MAX_IMAGE_RAW_BYTES / 1024 / 1024)}MB 上限。`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma === -1) return;
      setImages((prev) => [
        ...prev,
        {
          data: dataUrl.slice(comma + 1),
          mime: file.type,
          ...(file.name === '' ? {} : { name: file.name }),
          previewUrl: dataUrl,
        },
      ]);
      setAttachError(undefined);
    };
    reader.onerror = () => {
      setAttachError(`"${file.name}" 读取失败。`);
    };
    reader.readAsDataURL(file);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const imageItems = Array.from(e.clipboardData.items).filter(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    );
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file !== null) addFile(file);
    }
  };

  const canSend = (text.trim() !== '' || images.length > 0) && !disabled;

  const submit = (): void => {
    if (!canSend) return;
    const trimmed = text.trim();
    const toSend: ImageAttachment[] = images.map(({ data, mime, name }) => ({
      data,
      mime,
      ...(name === undefined ? {} : { name }),
    }));
    setText('');
    setImages([]);
    void send(trimmed, toSend.length > 0 ? toSend : undefined);
  };

  return (
    <div className="border-t border-[var(--xm-border)] p-3">
      <div className="mx-auto max-w-3xl">
        {attachError !== undefined && (
          <p className="mb-1.5 text-xs text-[var(--xm-danger)]">{attachError}</p>
        )}
        <div
          className={cn(
            'rounded-lg border border-[var(--xm-border)] bg-[var(--xm-surface)]',
            'focus-within:border-[var(--xm-accent)]',
          )}
        >
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {images.map((img, i) => (
                <div key={i} className="relative">
                  <img
                    src={img.previewUrl}
                    alt={img.name ?? '待发送的图片'}
                    className="h-14 w-14 rounded-md object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setImages((prev) => prev.filter((_, j) => j !== i));
                    }}
                    className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[10px] leading-none text-white"
                    aria-label="移除这张图"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {/*
            去掉 Textarea 自带边框/圆角/焦点描边——这些由外层外壳统一承担，
            避免"框套框"。组件本身仍复用，不另起一份 textarea 样式。
          */}
          <Textarea
            rows={2}
            value={text}
            disabled={disabled}
            placeholder="说点什么…"
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={onPaste}
            className="rounded-none border-0 bg-transparent px-3.5 pb-1.5 pt-3 leading-relaxed focus:border-transparent"
          />
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-0.5">
            <p className="select-none px-1 text-[11px] text-[var(--xm-fg-muted)]">
              Enter 发送 · Shift+Enter 换行 · 可粘贴图片
            </p>
            {running ? (
              <Button
                onClick={() => {
                  void stop();
                }}
                aria-label="停止"
                title="停止"
                className="h-8 w-8 shrink-0 px-0"
              >
                <StopIcon />
              </Button>
            ) : (
              <Button
                onClick={submit}
                disabled={!canSend}
                aria-label="发送"
                title="发送"
                className="h-8 w-8 shrink-0 px-0"
              >
                <SendIcon />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
