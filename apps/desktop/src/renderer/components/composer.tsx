import { useState } from 'react';
import type { ClipboardEvent, ReactNode } from 'react';
import type { ImageAttachment } from '../../shared/ipc.js';
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_RAW_BYTES } from '../../shared/ipc.js';
import { Button, Textarea } from './ui.js';
import { useUi } from '../store.js';

/**
 * 输入区。跑起来之后发送按钮**变成**停止按钮，不是并排多一个。
 *
 * 并排两个按钮意味着"发送"在跑动期间是可点的，那要么排队要么静默丢弃——
 * 两种都会让用户以为第二条消息生效了。原地替换的语义没有歧义：
 * 这一刻要么能发，要么能停。
 */
/** 待发送的一张图。`previewUrl` 就是完整的 data URL，缩略图直接用它，不用另起一次读取 */
interface PendingImage {
  readonly data: string;
  readonly mime: string;
  readonly name?: string;
  readonly previewUrl: string;
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

  const submit = (): void => {
    const trimmed = text.trim();
    if ((trimmed === '' && images.length === 0) || disabled) return;
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
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <img
                  src={img.previewUrl}
                  alt={img.name ?? '待发送的图片'}
                  className="h-14 w-14 rounded object-cover"
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
        {attachError !== undefined && (
          <p className="mb-1 text-xs text-red-500">{attachError}</p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            value={text}
            disabled={disabled}
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行，可以直接粘贴图片）"
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
          />
          {running ? (
            <Button
              onClick={() => {
                void stop();
              }}
            >
              停止
            </Button>
          ) : (
            <Button onClick={submit} disabled={disabled}>
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
