import type {
  AbortLike,
  OsFamily,
  RegisteredTool,
  WorkspaceIndex,
} from '@xm/kernel';
import type { EditProposal, EditProposalId, EventOf, SessionId } from '@xm/contracts';
import type { ResultExpandOptions, SubagentExplorer, TodoUpdater } from '@xm/runtime';
import { resultExpandTool, runCodeTool, subagentExploreTool, todoUpdateTool } from '@xm/runtime';

interface EditProposalAccess {
  save(sessionId: SessionId, proposal: EditProposal): Promise<void>;
  get(
    sessionId: SessionId,
    proposalId: EditProposalId,
  ): Promise<
    | { readonly proposal: EditProposal; readonly applied: boolean; readonly reviewed: boolean }
    | undefined
  >;
  markApplied(sessionId: SessionId, proposalId: EditProposalId): Promise<void>;
  /** 卡片动作认领一次审阅时落 `edit.reviewed`。窄写入口，不是通用 `record()` */
  markReviewed(
    sessionId: SessionId,
    proposalId: EditProposalId,
    selectedHunkIds: readonly string[],
  ): Promise<void>;
}

interface PtyManager {
  has(sessionId: SessionId, ptySessionId: string): boolean;
  disposeAll(): void;
}

interface OptionalToolsModule {
  readonly PtySessionManager: new (options: {
    readonly os: OsFamily;
    readonly emit: (sessionId: SessionId, event: PtySessionEvent) => void;
  }) => PtyManager;
  coreTools(options: {
    readonly os: OsFamily;
    readonly index: WorkspaceIndex;
    readonly backgroundSignal: AbortLike;
    readonly tempDir: string;
  }): readonly RegisteredTool[];
  shellSessionTools(manager: PtyManager): readonly RegisteredTool[];
  editPreviewTool(access: EditProposalAccess): RegisteredTool;
  editApplyTool(access: EditProposalAccess): RegisteredTool;
}

type PtySessionEventType =
  | 'shell.session.opened'
  | 'shell.session.output'
  | 'shell.session.command.started'
  | 'shell.session.command.finished'
  | 'shell.session.closed';

export type PtySessionEvent = {
  readonly [T in PtySessionEventType]: {
    readonly type: T;
    readonly payload: EventOf<T>['payload'];
  };
}[PtySessionEventType];

export interface ProductionToolHost {
  readonly available: boolean;
  readonly tools: readonly RegisteredTool[];
  hasSession(sessionId: SessionId, ptySessionId: string): boolean;
  dispose(): void;
}

export interface ProductionToolOptions {
  readonly os: OsFamily;
  readonly updateTodos: TodoUpdater;
  readonly expandResults: ResultExpandOptions;
  readonly editProposals: EditProposalAccess;
  readonly index: WorkspaceIndex;
  readonly backgroundSignal: AbortLike;
  readonly tempDir: string;
  readonly explore: SubagentExplorer;
  readonly emitPty: (sessionId: SessionId, event: PtySessionEvent) => void;
}

const loadOptionalTools = async (): Promise<OptionalToolsModule | undefined> => {
  const moduleId = ['@xm', 'tools-core'].join('/');
  try {
    return await import(moduleId) as OptionalToolsModule;
  } catch (error) {
    const code = (error as { readonly code?: string }).code;
    const missing = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
    if (missing && error instanceof Error && error.message.includes(moduleId)) return undefined;
    throw error;
  }
};

/** 桌面端唯一的可选业务包加载点；缺包时返回空工具宿主。 */
export async function openProductionTools(
  options: ProductionToolOptions,
): Promise<ProductionToolHost> {
  const module = await loadOptionalTools();
  if (module === undefined) {
    return { available: false, tools: [], hasSession: () => false, dispose: () => undefined };
  }
  const pty = new module.PtySessionManager({ os: options.os, emit: options.emitPty });
  const tools = [
    ...module.coreTools({
      os: options.os,
      index: options.index,
      backgroundSignal: options.backgroundSignal,
      tempDir: options.tempDir,
    }),
    ...module.shellSessionTools(pty),
    todoUpdateTool(options.updateTodos),
    resultExpandTool(options.expandResults),
    module.editPreviewTool(options.editProposals),
    module.editApplyTool(options.editProposals),
    subagentExploreTool(options.explore),
    /*
     * Code Mode 的入口。装不装运行时由 profile 的 `runtime.code` 那一行决定；
     * 这里只管注册工具——没装运行时的话 `ctx.codeMode` 缺席，它会老实说自己不可用。
     * 呈现模式默认 native，模型压根看不见它（ADR-0061 §二）。
     */
    runCodeTool(),
  ];
  return {
    available: true,
    tools,
    hasSession: (sessionId, ptySessionId) => pty.has(sessionId, ptySessionId),
    dispose: () => { pty.disposeAll(); },
  };
}
