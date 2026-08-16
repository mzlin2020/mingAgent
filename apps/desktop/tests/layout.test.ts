import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHAT_COLUMN,
  CHAT_CONTENT_WIDTH_PX,
  CHAT_GUTTER_PX,
  COMPOSER_EXTRA_PX,
  COMPOSER_FADE_PX,
  TOOL_ROW_GLARE_PX,
  TOOL_ROW_HEIGHT_PX,
  CONTEXT_METER_SIZE_PX,
  TO_BOTTOM_SIZE_PX,
  isConversationHero,
  workspaceLabel,
} from '../src/renderer/lib/layout.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'src/renderer/styles.css'), 'utf8');

describe('共享宽度轴', () => {
  it('三个组件变量的数字是契约：正文 720、输入卡 +32、两侧 gutter 16', () => {
    expect(CHAT_CONTENT_WIDTH_PX).toBe(720);
    expect(COMPOSER_EXTRA_PX).toBe(32);
    expect(CHAT_GUTTER_PX).toBe(16);
    expect(COMPOSER_FADE_PX).toBe(36);
    expect(TOOL_ROW_HEIGHT_PX).toBe(24);
    expect(TOOL_ROW_GLARE_PX).toBe(300);
    expect(TO_BOTTOM_SIZE_PX).toBe(34);
    expect(CONTEXT_METER_SIZE_PX).toBe(14);
  });

  it('CSS 里的三个 --xm 变量与 JS 常量同值，没人只改了一处', () => {
    expect(CSS).toContain(`--xm-chat-content-width: ${String(CHAT_CONTENT_WIDTH_PX)}px`);
    expect(CSS).toContain(
      `--xm-composer-card-max-width: calc(var(--xm-chat-content-width) + ${String(COMPOSER_EXTRA_PX)}px)`,
    );
    expect(CSS).toContain(`--xm-chat-gutter: ${String(CHAT_GUTTER_PX)}px`);
  });

  it('Home / 对话共用同一条轴类，不再各写一个 max-w-*', () => {
    expect(CHAT_COLUMN).toBe('chat-axis chat-axis__body');
  });

  it('工具行 24px、扫光 300px、回到底部负 margin 34px 写在 CSS 里', () => {
    expect(CSS).toContain('height: 24px');
    expect(CSS).toContain('margin-top: -34px');
    expect(CSS).toContain('width: 300px');
  });

  it('渐变遮罩是 36px 不是百分比——输入框长高时带不能跟着拉长', () => {
    expect(CSS).toMatch(
      /linear-gradient\(\s*180deg,\s*transparent 0px,\s*var\(--color-canvas\) 36px/,
    );
    expect(CSS).not.toMatch(/composer-seat[\s\S]{0,400}36%/);
  });

  it('占用环视觉 14px，减动效下不过渡', () => {
    expect(CSS).toContain('width: 14px');
    expect(CSS).toMatch(/\.context-meter__ring[\s\S]{0,80}width: 14px/);
    expect(CSS).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*\.context-meter__fill[\s\S]*transition: none/,
    );
  });

  it('prefers-reduced-motion 下 shimmer 与扫光带静止', () => {
    expect(CSS).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*\.turn-status-shimmer[\s\S]*animation: none/,
    );
    expect(CSS).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*\.tool-row\[data-pending\]::after[\s\S]*animation: none/,
    );
  });
});

describe('isConversationHero', () => {
  const empty = {
    messageCount: 0,
    hasLiveMessage: false,
    running: false,
    busy: false,
    pendingCount: 0,
  };

  it('零消息的会话是 hero，不是 Home', () => {
    expect(isConversationHero(empty)).toBe(true);
  });

  it('发出第一条（消息 / 在途 / 回合 / 排队）就 dock', () => {
    expect(isConversationHero({ ...empty, messageCount: 1 })).toBe(false);
    expect(isConversationHero({ ...empty, hasLiveMessage: true })).toBe(false);
    expect(isConversationHero({ ...empty, running: true })).toBe(false);
    expect(isConversationHero({ ...empty, busy: true })).toBe(false);
    expect(isConversationHero({ ...empty, pendingCount: 1 })).toBe(false);
  });
});

describe('workspaceLabel', () => {
  it('空路径不显示，只取最后一段目录名', () => {
    expect(workspaceLabel(undefined)).toBeUndefined();
    expect(workspaceLabel('')).toBeUndefined();
    expect(workspaceLabel('/Users/me/code/mingAgent')).toBe('mingAgent');
    expect(workspaceLabel('C:\\Users\\me\\code\\mingAgent')).toBe('mingAgent');
  });
});

describe('hero 列必须撑满滚动视口', () => {
  it('conversation 用 flex:1 + min-height:100%，否则 justify-content:center 没有盒子', () => {
    expect(CSS).toMatch(/flex: 1 0 auto;\s*min-height: 100%;/);
    expect(CSS).toMatch(/\.conversation--hero\s*\{[^}]*justify-content:\s*center/);
  });
});
