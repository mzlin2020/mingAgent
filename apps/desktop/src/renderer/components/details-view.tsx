import type { ReactNode } from 'react';
import type { CallMaterial } from '../lib/call-material.js';
import {
  formatDispatchOutput,
  formatInputJson,
} from '../lib/call-material.js';

/**
 * 选中那次调用的 Input / Output。代码段 r12 / pad16 / mono 13-22（总纲 §7）。
 *
 * 不认识任何具体工具：native 与 dispatch 的差别只来自材料的 `kind`。
 */
export function DetailsView({
  material,
}: {
  readonly material: CallMaterial | undefined;
}): ReactNode {
  if (material === undefined) {
    return (
      <p className="px-1 py-2 text-meta text-muted">点对话里的一次工具调用，查看入参与结果。</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <DetailsSection title="Input">
        <pre className="details-code">{formatInputJson(material.input)}</pre>
      </DetailsSection>
      <DetailsSection title="Output">
        {material.kind === 'native' ? (
          <NativeOutput material={material} />
        ) : (
          <DispatchOutput material={material} />
        )}
      </DetailsSection>
    </div>
  );
}

function DetailsSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section>
      <h3 className="mb-2 text-meta font-medium text-muted">{title}</h3>
      {children}
    </section>
  );
}

function NativeOutput({
  material,
}: {
  readonly material: Extract<CallMaterial, { kind: 'native' }>;
}): ReactNode {
  if (material.output === undefined) {
    return <pre className="details-code text-faint">运行中…</pre>;
  }
  return (
    <pre className={material.output.isError ? 'details-code text-danger' : 'details-code'}>
      {material.output.text}
    </pre>
  );
}

function DispatchOutput({
  material,
}: {
  readonly material: Extract<CallMaterial, { kind: 'dispatch' }>;
}): ReactNode {
  const formatted = formatDispatchOutput(material);
  return (
    <div className="flex flex-col gap-2">
      <pre className={material.ok ? 'details-code' : 'details-code text-danger'}>
        {formatted.body}
      </pre>
      <p className="text-micro text-faint">{formatted.notice}</p>
    </div>
  );
}
