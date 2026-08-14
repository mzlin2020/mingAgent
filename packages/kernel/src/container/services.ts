import type {
  AgentId,
  CallId,
  CheckpointId,
  EditProposalId,
  EventId,
  MessageId,
  PtySessionId,
  RequestId,
  SessionId,
  TurnId,
} from '@xm/contracts';
import type { ExecutionWorld } from '../port/execution-world.js';

export interface ClockService {
  now(): number;
}

export interface DeterministicClock extends ClockService {
  advance(ms: number): void;
}

export interface IdService {
  session(): SessionId;
  event(): EventId;
  turn(): TurnId;
  message(): MessageId;
  call(): CallId;
  request(): RequestId;
  agent(): AgentId;
  checkpoint(): CheckpointId;
  editProposal(): EditProposalId;
  ptySession(): PtySessionId;
}

export interface CoreContainerServices {
  readonly clock: ClockService;
  readonly ids: IdService;
  readonly executor: ExecutionWorld;
}

export interface DeterministicClockOptions {
  readonly start: number;
  readonly step?: number;
}

const assertFinite = (value: number, name: string): void => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} 必须是有限数字。`);
};

export const createDeterministicClock = (
  options: DeterministicClockOptions,
): DeterministicClock => {
  assertFinite(options.start, 'start');
  const step = options.step ?? 1;
  assertFinite(step, 'step');
  if (step < 0) throw new RangeError('step 不能为负数。');
  let current = options.start;
  return {
    now(): number {
      const value = current;
      current += step;
      return value;
    },
    advance(ms: number): void {
      assertFinite(ms, 'advance(ms)');
      if (ms < 0) throw new RangeError('advance(ms) 不能为负数。');
      current += ms;
    },
  };
};

const MAX_UUID_TAIL = 0xffffffffffff;

const deterministicUuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

export const createDeterministicIds = (start = 1): IdService => {
  if (!Number.isSafeInteger(start) || start < 0 || start > MAX_UUID_TAIL) {
    throw new RangeError('start 必须是 UUID 尾段范围内的非负安全整数。');
  }
  let next = start;
  const take = (): string => {
    if (next > MAX_UUID_TAIL) throw new RangeError('确定性 ID 序列已超出 UUID 尾段范围。');
    return deterministicUuid(next++);
  };
  return {
    session: () => take() as SessionId,
    event: () => take() as EventId,
    turn: () => take() as TurnId,
    message: () => take() as MessageId,
    call: () => take() as CallId,
    request: () => take() as RequestId,
    agent: () => take() as AgentId,
    checkpoint: () => take() as CheckpointId,
    editProposal: () => take() as EditProposalId,
    ptySession: () => take() as PtySessionId,
  };
};
