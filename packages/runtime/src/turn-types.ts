import type { AgentInbox } from './agent.js';
import type { TurnCoreDeps } from './turn-deps.js';
import type { TurnExtensionHost } from './turn-extension-host.js';

export interface TurnDeps extends TurnCoreDeps {
  readonly extensions?: TurnExtensionHost;
  readonly inbox?: AgentInbox;
}

export type { PendingCall, TurnCoreDeps } from './turn-deps.js';
