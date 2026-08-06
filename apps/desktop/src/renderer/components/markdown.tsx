import { useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/cn.js';

/**
 * 模型输出的 Markdown 渲染。
 *
 * ── 安全上只有一条，但它是硬的：**不渲染原始 HTML** ──
 *
 * 这里渲染的是模型输出，而模型输出的一部分来自它读到的文件、将来还会来自网页与 MCP。
 * 渲染进程握着 preload 那根管子，一次 XSS 就是一条通往主进程接口的路。
 *
 * `react-markdown` 默认就不渲染原始 HTML——它把 Markdown 解析成 AST 再建 React 元素，
 * 全程没有 `dangerouslySetInnerHTML`。**所以这个文件里永远不许出现 `rehype-raw`**，
 * 那个插件存在的唯一作用就是把这道默认防线关掉。
 *
 * ── 语法高亮推后 ──
 *
 * shiki 要带一份几 MB 的语法定义，highlight.js 的主题多半要 inline style
 * （而 CSP 里 `style-src` 目前允许 unsafe-inline，我不想让它变成"必须允许"）。
 * 先把代码块做成可读、可复制的样子，高亮等 M1-e 的 UI 收尾。
 */
export function MarkdownText({ text }: { readonly text: string }): ReactNode {
  return (
    <div className="xm-md flex flex-col gap-2 text-sm leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeBlock,
          a: ({ children, href }) => (
            // 链接不可点：渲染层不许发起导航（CSP 的 connect-src 只有 self）。
            // 显示出来但不给 href，用户看得见它指向哪，而模型点不动任何东西
            <span className="underline decoration-dotted" title={href}>
              {children}
            </span>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--xm-border)] px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[var(--xm-border)] px-2 py-1">{children}</td>
          ),
          ul: ({ children }) => <ul className="ml-5 list-disc">{children}</ul>,
          ol: ({ children }) => <ol className="ml-5 list-decimal">{children}</ol>,
          h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-medium">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[var(--xm-border)] pl-3 text-[var(--xm-fg-muted)]">
              {children}
            </blockquote>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

/**
 * 把 `children` 摊成纯文本。
 *
 * `react-markdown` 交下来的是 ReactNode——代码块通常是一个字符串，但一段带
 * 软换行的代码会是数组。`String(node)` 对数组以外的元素会得到 `[object Object]`，
 * 而那正好会被原样复制到用户的剪贴板里。
 */
function flatten(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flatten).join('');
  return '';
}

/**
 * 代码块与行内代码。
 *
 * `react-markdown` 把两者都交给 `code`，靠 className 上有没有 `language-` 区分——
 * 行内代码是没有 className 的那个。
 */
function CodeBlock({
  className,
  children,
}: {
  readonly className?: string | undefined;
  readonly children?: ReactNode | undefined;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const language = /language-(\w+)/.exec(className ?? '')?.[1];
  const source = flatten(children).replace(/\n$/, '');

  if (language === undefined && !source.includes('\n')) {
    return (
      <code className="rounded bg-[var(--xm-surface-2)] px-1 py-0.5 font-mono text-[0.9em]">
        {children}
      </code>
    );
  }

  return (
    <div className="group relative">
      <div className="flex items-center justify-between border-b border-[var(--xm-border)] bg-[var(--xm-surface-2)] px-2 py-1 text-xs text-[var(--xm-fg-muted)]">
        <span className="font-mono">{language ?? 'text'}</span>
        <button
          className={cn('hover:text-[var(--xm-fg)]', copied && 'text-[var(--xm-fg)]')}
          onClick={() => {
            void navigator.clipboard.writeText(source).then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1200);
            });
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto bg-[var(--xm-surface-2)] p-2 text-xs">
        <code className="font-mono">{source}</code>
      </pre>
    </div>
  );
}
