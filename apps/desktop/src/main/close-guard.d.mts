export interface CloseGuardOptions {
  flush: () => unknown | Promise<unknown>;
  confirmDiscard: () => boolean | Promise<boolean>;
  close: () => void;
  timeoutMs?: number;
}
export declare function createCloseGuard(options: CloseGuardOptions): {
  readonly allowed: boolean;
  request(): Promise<boolean>;
};
