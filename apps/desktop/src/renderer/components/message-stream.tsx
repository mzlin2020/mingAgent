import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { BlobRef, ContentBlock, Message } from '@xm/contracts';
import { api } from '../bridge.js';
import { Disclosure } from './disclosure.js';
import { MarkdownText } from './markdown.js';
import { cn } from '../lib/cn.js';

/**
 * 消息流。工具结果先索引一遍，再交给每条消息——`tool_use` 与 `tool_result`
 * 分处两条消息，不索引就配不成一张卡（见 `indexResults`）。
 */
export function MessageStream({ messages }: { readonly messages: readonly Message[] }): ReactNode {
  const results = indexResults(messages);
  return (
    <>
      {messages.map((m) => (
        <MessageView key={m.id} message={m} results={results} />
      ))}
    </>
  );
}

/**
 * 一次工具调用的结果，按 `toolUseId` 索引。
 *
 * 契约上 `tool_use` 与 `tool_result` 落在**两条不同的消息**里（前者在 assistant 的
 * message.end，后者由 tool.end 追加）。照事件流的顺序平铺出来，用户看到的是
 * "一个请求" + 隔了几行的"一段输出"，中间还可能夹着别的调用——一次并行调用之后
 * 就完全对不上号了。所以这里先把结果索引起来，再合并成一张卡。
 */
type ResultIndex = ReadonlyMap<string, Extract<ContentBlock, { type: 'tool_result' }>>;

function indexResults(messages: readonly Message[]): ResultIndex {
  const out = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === 'tool_result') out.set(b.toolUseId, b);
    }
  }
  return out;
}

/**
 * 一条消息。
 *
 * ── 助手的回复不套卡片 ──
 *
 * 上一版用户和助手都套一层同样粗细的边框，一屏几十个框，边框因此什么也不区分。现在框留给
 * "机器干的事"：工具卡、终端、审批卡。模型说的话直接排在页面底色上，人说的话是一片浅色
 * 气泡——**一个框出现在正文里就代表这不是模型在说话**。
 *
 * 助手侧的容器类必须和 `live-views.tsx` 的 `LiveMessage` 保持一致，否则 `message.end`
 * 那一刻同一段文字会从一种外观跳成另一种。共用的那份写在 `ASSISTANT_BODY`。
 */
export const ASSISTANT_BODY = 'flex flex-col gap-3';

/** 角色标签：micro 级、faint 色。它是给"这段是谁说的"兜底的，不该跟正文抢注意力 */
export function RoleLabel({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className="mb-1.5 text-micro font-medium tracking-wide text-faint">{children}</div>;
}

function MessageView({
  message,
  results,
}: {
  readonly message: Message;
  readonly results: ResultIndex;
}): ReactNode {
  // 只含 tool_result 的消息不单独成卡：它的内容已经并进了发起它的那张工具卡
  const visible = message.blocks.filter((b) => b.type !== 'tool_result');
  if (visible.length === 0) return null;

  const blocks = visible.map((b, i) => <BlockView key={i} block={b} results={results} />);

  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end">
        <RoleLabel>你</RoleLabel>
        <div className="max-w-[85%] rounded-card bg-surface-2 px-4 py-2.5 text-body">
          <div className="flex flex-col gap-3">{blocks}</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <RoleLabel>小明</RoleLabel>
      <div className={ASSISTANT_BODY}>{blocks}</div>
    </div>
  );
}

function BlockView({
  block,
  results,
}: {
  readonly block: ContentBlock;
  readonly results: ResultIndex;
}): ReactNode {
  switch (block.type) {
    case 'text':
      return <MarkdownText text={block.text} />;

    case 'thinking':
      return (
        <Disclosure label="思考过程" summaryClassName="text-meta">
          <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-meta text-muted">
            {block.text}
          </p>
        </Disclosure>
      );

    case 'tool_use':
      return <ToolCard name={block.name} input={block.input} result={results.get(block.id)} />;

    case 'image':
      return <ImageBlockView source={block.source} />;

    case 'tool_result':
      // 正常路径下走不到这里（上面已经并进工具卡）。留着是兜底：
      // 一个找不到发起者的结果**照样要显示**，不能因为配不上对就从界面上消失
      //
      // `c.type === 'image'` 这里仍然只走 `[image]` 兜底占位——目前没有任何工具会
      // 产出图片结果，真正实现的是用户在 Composer 里贴的图（顶层 image 块，上面那支）
      return (
        <div className="rounded-control border border-border px-3 py-2 text-meta">
          {block.content.map((c, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {c.type === 'text' ? c.text : `[${c.type}]`}
            </p>
          ))}
        </div>
      );

    default:
      // 未知块类型原样跳过，不让整条消息渲染失败——与事件流的处理保持一致
      return null;
  }
}

/**
 * 把 `BlobRef` 反查成字节再渲染。渲染进程从来没有反查过 blob 内容（`readBlob` 是
 * 第一条这样的 IPC），所以这里用 `useEffect` 拉一次、按 `source.hash` 做依赖——
 * 同一张图不会因为父组件重渲染就再打一次 IPC。
 */
function ImageBlockView({ source }: { readonly source: BlobRef }): ReactNode {
  const [dataUrl, setDataUrl] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(undefined);
    setFailed(false);
    api
      .readBlob(source)
      .then((res) => {
        if (!cancelled) setDataUrl(res.dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // 依赖只写 hash（不是整个 source 对象）：同一张图的 BlobRef 每次从事件流解出来
    // 都是新对象，按引用做依赖会导致每次父组件重渲染都重新拉一次
  }, [source.hash]);

  if (failed) {
    return <p className="text-meta text-muted">[图片读取失败]</p>;
  }
  if (dataUrl === undefined) {
    return <p className="text-meta text-muted">[加载图片…]</p>;
  }
  return (
    <img src={dataUrl} alt={source.name ?? '图片'} className="max-w-full rounded-control" />
  );
}

/**
 * 工具调用卡片：请求与结果合成一张。
 *
 * 结果默认折叠。理由不是省地方，是**结果是给模型看的**——它经常是几百行文件内容，
 * 铺开来会把对话本身淹掉。用户想看的时候点开，而"它到底做了什么"（工具名 + 入参）
 * 始终可见。
 */
function ToolCard({
  name,
  input,
  result,
}: {
  readonly name: string;
  readonly input: unknown;
  readonly result: Extract<ContentBlock, { type: 'tool_result' }> | undefined;
}): ReactNode {
  const failed = result?.isError === true;
  const text = (result?.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n');

  return (
    <div
      className={cn(
        'overflow-hidden rounded-control border text-meta',
        failed ? 'border-danger-border' : 'border-border',
      )}
    >
      <div className={cn('flex items-baseline gap-2.5 px-3 py-1.5', failed && 'bg-danger-bg')}>
        <span className="font-mono font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted">{summarize(input)}</span>
        <span className={cn('shrink-0', failed ? 'text-danger' : 'text-faint')}>
          {result === undefined ? '进行中' : failed ? '失败' : '完成'}
        </span>
      </div>
      {text !== '' && (
        <Disclosure
          className="border-t border-border"
          summaryClassName="px-3 py-1.5"
          label={failed ? '查看错误' : `查看结果（${String(text.split('\n').length)} 行）`}
        >
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-3 pb-2.5 font-mono text-muted">
            {text}
          </pre>
        </Disclosure>
      )}
    </div>
  );
}

/** 工具入参的一行摘要。路径类的最有用，其余退回紧凑 JSON */
function summarize(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input);
  const record = input as Record<string, unknown>;
  const path = record.path;
  if (typeof path === 'string') return path;
  return JSON.stringify(input);
}
