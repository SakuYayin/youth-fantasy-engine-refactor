export declare function rendererDevUrl(value: unknown, packaged?: boolean): string | null;
export declare function isRendererUrl(candidate: string, rendererPath: string, devUrl?: string | null): boolean;
export declare function isExternalUrl(value: string): boolean;
interface Frame { url: string }
interface Contents { mainFrame: Frame }
export declare function isTrustedSender(
  event: { sender: unknown; senderFrame: Frame | null },
  window: { isDestroyed(): boolean; webContents: Contents } | null,
  rendererPath: string,
  devUrl?: string | null,
): boolean;
