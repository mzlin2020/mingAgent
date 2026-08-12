export interface NavigationWebContents {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): void;
  getURL(): string;
}

/** Keep the renderer on its application document and deny all renderer-created windows. */
export function secureNavigation(webContents: NavigationWebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    if (url !== webContents.getURL()) event.preventDefault();
  });
}
