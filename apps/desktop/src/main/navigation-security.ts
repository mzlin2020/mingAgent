export interface NavigationWebContents {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): void;
  getURL(): string;
}

/** 把渲染层钉在它自己的应用文档上，并拒绝渲染层创建的一切新窗口。 */
export function secureNavigation(webContents: NavigationWebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    if (url !== webContents.getURL()) event.preventDefault();
  });
}
