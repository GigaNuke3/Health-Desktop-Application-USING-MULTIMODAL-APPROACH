import type { BrowserWindow } from 'electron';

export function buildCsp(dev: boolean): string {
  const scriptSrc = ["'self'"];
  const connectSrc = ["'self'"];
  if (dev) {
    scriptSrc.push("'unsafe-inline'");
    connectSrc.push('ws://localhost:*');
  }

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `connect-src ${connectSrc.join(' ')}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'none'`,
  ];
  return directives.join('; ');
}

export function hardenWindow(win: BrowserWindow): void {
  const devUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const csp = buildCsp(!!devUrl);
  // Packaged app loads from file://, dev loads from the Vite server.
  const appOrigin = devUrl ? new URL(devUrl).origin : 'file://';

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appOrigin)) event.preventDefault();
  });
}
