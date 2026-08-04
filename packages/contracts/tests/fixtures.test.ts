import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERSISTED_EVENT_TYPES, isCoreEvent, parseStoredEvent } from '@xm/contracts';

/**
 * Fixture 回归 —— docs/10 §12 验收项。
 *
 * `fixtures/events/v<N>/` 下按版本存归档事件流，每次发版新增一份。
 * 这是**唯一**能防住格式漂移的手段：schema 改了、upcaster 漏了、字段语义变了，
 * 都会在这里炸出来，而不是等某个用户三个月后打开旧会话时才发现。
 *
 * 加事件类型时请顺手更新 fixture；改事件版本时请**新增**一份，不要改旧的。
 */
const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/events', import.meta.url));

const versions = readdirSync(FIXTURE_DIR).filter((d) => /^v\d+$/.test(d));

describe('历史事件 fixture 全部可解析', () => {
  it('至少存在一份 fixture', () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  for (const version of versions) {
    const dir = `${FIXTURE_DIR}/${version}`;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      it(`${version}/${file}`, () => {
        const rows = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as unknown[];
        expect(rows.length).toBeGreaterThan(0);

        const events = rows.map((r) => parseStoredEvent(r));

        // 持久化流的 seq 必须从 1 起、无空洞（docs/10 §4.1）
        const persistedSeqs = events
          .filter((e) => isCoreEvent(e) && PERSISTED_EVENT_TYPES.includes(e.type))
          .map((e) => e.seq);
        expect(persistedSeqs).toEqual(persistedSeqs.map((_, i) => i + 1));
      });
    }
  }
});
