import type { WaitingPlugin } from './types.js';

export class ContainerInactiveError extends Error {
  override readonly name = 'ContainerInactiveError';

  constructor(label: string) {
    super(`${label} 已卸载，不能再注册效果。`);
  }
}

export class MissingServiceError extends Error {
  override readonly name = 'MissingServiceError';
  readonly service: string;

  constructor(service: string) {
    super(`服务 "${service}" 未提供；插件必须通过 inject 声明并等待装配。`);
    this.service = service;
  }
}

export class ServiceConflictError extends Error {
  override readonly name = 'ServiceConflictError';

  constructor(service: string, detail: string) {
    super(`服务 "${service}" 在同一作用域内冲突：${detail}`);
  }
}

export class PluginProvideError extends Error {
  override readonly name = 'PluginProvideError';
  readonly plugin: string;
  readonly service: string;

  constructor(plugin: string, service: string, reason: string) {
    super(`插件 "${plugin}" 的服务 "${service}" ${reason}（ADR-0068）。`);
    this.plugin = plugin;
    this.service = service;
  }
}

export class ContainerDependencyError extends Error {
  override readonly name = 'ContainerDependencyError';
  readonly waiting: readonly WaitingPlugin[];
  readonly chain?: readonly string[];

  constructor(waiting: readonly WaitingPlugin[], detail: string, chain?: readonly string[]) {
    super(`插件装配无法收敛：${detail}`);
    this.waiting = waiting;
    if (chain !== undefined) this.chain = chain;
  }
}

export class EventDefinitionError extends Error {
  override readonly name = 'EventDefinitionError';

  constructor(name: string, expected: string, actual: string) {
    super(`容器事件 "${name}" 已登记为 ${expected}，不能再按 ${actual} 使用。`);
  }
}

export class DispatchAbortedError extends Error {
  override readonly name = 'AbortError';

  constructor(eventName: string) {
    super(`容器事件 "${eventName}" 已取消。`);
  }
}
