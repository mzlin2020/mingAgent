import { describe, expect, it, vi } from 'vitest';
import { secureNavigation } from '../src/main/navigation-security.js';

describe('Electron navigation security', () => {
  it('denies new windows and navigation away from the current application document', () => {
    let openHandler: (() => { action: 'deny' }) | undefined;
    let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const webContents = {
      setWindowOpenHandler: (handler: () => { action: 'deny' }) => { openHandler = handler; },
      on: (_event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void) => { navigate = listener; },
      getURL: () => 'file:///app/index.html',
    };
    secureNavigation(webContents);
    expect(openHandler?.()).toEqual({ action: 'deny' });
    const external = { preventDefault: vi.fn() };
    navigate?.(external, 'https://attacker.example/');
    expect(external.preventDefault).toHaveBeenCalledOnce();
    const same = { preventDefault: vi.fn() };
    navigate?.(same, 'file:///app/index.html');
    expect(same.preventDefault).not.toHaveBeenCalled();
  });
});
