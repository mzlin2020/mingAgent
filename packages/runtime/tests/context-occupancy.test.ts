import type { ModelRequest } from '@xm/contracts';
import { ContextOccupancy, newMessageId } from '@xm/contracts';
import { describe, expect, it } from 'vitest';
import {
  estimateRequestTokens,
  projectContextOccupancy,
} from '../src/context-occupancy.js';

const request = (text = '你好'): ModelRequest => ({
  model: 'scripted-1',
  system: [{ text: '你是小明。', cacheable: true }],
  messages: [
    {
      id: newMessageId(),
      role: 'user',
      ts: 1,
      blocks: [{ type: 'text', text }],
    },
  ],
  tools: [
    {
      name: 'fs.read',
      group: 'fs',
      description: '读文件',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      risk: 'safe',
      capabilities: ['fs.read'],
      concurrency: 'parallel',
      resultLimits: { maxBytes: 1024, maxBlocks: 4, strategy: 'middle' },
      source: { kind: 'builtin' },
    },
  ],
  maxOutputTokens: 1024,
});

describe('projectContextOccupancy', () => {
  it('三段之和等于 total，容量来自路由窗口', () => {
    const occupancy = projectContextOccupancy(request(), 200_000);
    expect(ContextOccupancy.parse(occupancy)).toEqual(occupancy);
    expect(occupancy.systemTokens + occupancy.toolsTokens + occupancy.conversationTokens).toBe(
      occupancy.totalTokens,
    );
    expect(occupancy.capacityTokens).toBe(200_000);
    expect(occupancy.systemTokens).toBeGreaterThan(0);
    expect(occupancy.toolsTokens).toBeGreaterThan(0);
    expect(occupancy.conversationTokens).toBeGreaterThan(0);
  });

  it('对话变长时占用单调不减；与整份请求估算对得上量级', () => {
    const shortReq = request('你好');
    const longReq = request(`你好${'甲'.repeat(400)}`);
    const short = projectContextOccupancy(shortReq, 8_000);
    const long = projectContextOccupancy(longReq, 8_000);
    expect(long.conversationTokens).toBeGreaterThan(short.conversationTokens);
    expect(long.totalTokens).toBeGreaterThan(short.totalTokens);
    const whole = estimateRequestTokens(longReq);
    expect(long.totalTokens).toBeGreaterThan(whole / 10);
    expect(long.totalTokens).toBeLessThan(whole * 10);
  });

  it('有精确计数时三段按比例摊到这个总数上，合计一字不差', () => {
    const occupancy = projectContextOccupancy(request(), 8_000, 1_200);
    expect(occupancy.totalTokens).toBe(1_200);
    expect(occupancy.systemTokens + occupancy.toolsTokens + occupancy.conversationTokens).toBe(
      1_200,
    );
  });

  it('相对按字节/4 的宽松估算，偏差方向稳定为高估', () => {
    const req = request(`hello ${'world '.repeat(80)}`);
    const occupancy = projectContextOccupancy(req, 8_000);
    const liberal = Math.ceil(new TextEncoder().encode(JSON.stringify(req)).byteLength / 4);
    expect(occupancy.totalTokens).toBeGreaterThanOrEqual(liberal);
  });

  it('占用投影进不了模型请求：函数不改入参', () => {
    const req = request();
    const before = JSON.stringify(req);
    projectContextOccupancy(req, 8_000);
    expect(JSON.stringify(req)).toBe(before);
  });
});
