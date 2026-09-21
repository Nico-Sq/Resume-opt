const CHANNEL_NAME = 'resume-opt-account-exit-v1';

type AccountExitMessage = {
  type: 'prepare' | 'cancel' | 'complete';
  userId: string;
  requestId: string;
};

interface MessageChannelLike {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  close(): void;
  postMessage(message: AccountExitMessage): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive' | 'shared'; signal?: AbortSignal },
    callback: () => Promise<T> | T,
  ): Promise<T>;
}

export interface AccountExitBarrierOptions {
  userId: string;
  onPrepare: () => Promise<void>;
  onCancel: () => void;
  onComplete: () => void;
  createChannel?: (name: string) => MessageChannelLike;
  locks?: LockManagerLike;
  timeoutMs?: number;
}

function isMessage(value: unknown): value is AccountExitMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.type === 'prepare' || message.type === 'cancel' || message.type === 'complete') &&
    typeof message.userId === 'string' &&
    typeof message.requestId === 'string'
  );
}

export class AccountExitBarrier {
  readonly #channel: MessageChannelLike;
  readonly #locks: LockManagerLike;
  readonly #lockName: string;
  readonly #timeoutMs: number;
  readonly #onMessage = (event: MessageEvent<unknown>) => {
    if (!isMessage(event.data) || event.data.userId !== this.options.userId) return;
    if (event.data.type === 'prepare') void this.#prepare();
    else if (event.data.type === 'cancel') this.options.onCancel();
    else this.options.onComplete();
  };
  #preparePromise: Promise<void> | null = null;
  #releaseShared: (() => void) | null = null;
  #releaseRequested = false;
  #sharedTask: Promise<unknown>;

  constructor(private readonly options: AccountExitBarrierOptions) {
    const createChannel = options.createChannel ?? ((name: string) => new BroadcastChannel(name));
    const locks = options.locks ?? (navigator as unknown as { locks?: LockManagerLike }).locks;
    if (!locks) throw new Error('当前浏览器不支持安全的多标签页退出');
    this.#channel = createChannel(CHANNEL_NAME);
    this.#locks = locks;
    this.#lockName = `resume-opt-account-${options.userId}`;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#channel.addEventListener('message', this.#onMessage);
    this.#sharedTask = this.#locks.request(this.#lockName, { mode: 'shared' }, async () => {
      await new Promise<void>((resolve) => {
        this.#releaseShared = resolve;
        if (this.#releaseRequested) resolve();
      });
    });
  }

  async #prepare(): Promise<void> {
    this.#preparePromise ??= this.options.onPrepare().finally(() => {
      this.#releaseRequested = true;
      this.#releaseShared?.();
    });
    await this.#preparePromise;
    await this.#sharedTask;
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const requestId = crypto.randomUUID();
    this.#channel.postMessage({ type: 'prepare', userId: this.options.userId, requestId });
    await this.#prepare();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      return await this.#locks.request(
        this.#lockName,
        { mode: 'exclusive', signal: controller.signal },
        work,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  cancel(): void {
    const message = {
      type: 'cancel',
      userId: this.options.userId,
      requestId: crypto.randomUUID(),
    } as const;
    this.#channel.postMessage(message);
    this.options.onCancel();
  }

  complete(): void {
    const message = {
      type: 'complete',
      userId: this.options.userId,
      requestId: crypto.randomUUID(),
    } as const;
    this.#channel.postMessage(message);
    this.options.onComplete();
  }

  dispose(): void {
    this.#channel.removeEventListener('message', this.#onMessage);
    this.#channel.close();
    this.#releaseRequested = true;
    this.#releaseShared?.();
  }
}
