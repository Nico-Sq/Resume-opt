import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountExitBarrier } from '../../apps/web/src/client/account/account-exit-barrier';

class TestChannel {
  static readonly channels = new Set<TestChannel>();
  static readonly messages: unknown[] = [];
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }
  postMessage(message: unknown): void {
    TestChannel.messages.push(message);
    for (const channel of TestChannel.channels) {
      if (channel === this) continue;
      for (const listener of channel.listeners)
        listener(new MessageEvent('message', { data: message }));
    }
  }
  close(): void {
    TestChannel.channels.delete(this);
  }
}

class TestLocks {
  shared = 0;
  exclusive: Array<() => void> = [];

  request<T>(
    _name: string,
    options: { mode: 'exclusive' | 'shared'; signal?: AbortSignal },
    callback: () => Promise<T> | T,
  ): Promise<T> {
    if (options.mode === 'shared') {
      this.shared += 1;
      return Promise.resolve(callback()).finally(() => {
        this.shared -= 1;
        if (this.shared === 0) this.exclusive.shift()?.();
      });
    }
    return new Promise<T>((resolve, reject) => {
      const run = () => void Promise.resolve(callback()).then(resolve, reject);
      const abort = () => {
        const index = this.exclusive.indexOf(run);
        if (index >= 0) this.exclusive.splice(index, 1);
        reject(new DOMException('aborted', 'AbortError'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (this.shared === 0) run();
      else this.exclusive.push(run);
    });
  }
}

function createChannel(): TestChannel {
  const channel = new TestChannel();
  TestChannel.channels.add(channel);
  return channel;
}

afterEach(() => {
  TestChannel.channels.clear();
  TestChannel.messages.length = 0;
  vi.useRealTimers();
});

describe('AccountExitBarrier', () => {
  it('pauses every known tab before exclusive cleanup and broadcasts completion without private data', async () => {
    const locks = new TestLocks();
    const prepared: string[] = [];
    const completed: string[] = [];
    const first = new AccountExitBarrier({
      userId: '00000000-0000-4000-8000-000000000001',
      locks,
      createChannel,
      onPrepare: () => {
        prepared.push('first');
        return Promise.resolve();
      },
      onCancel: () => undefined,
      onComplete: () => completed.push('first'),
    });
    const second = new AccountExitBarrier({
      userId: '00000000-0000-4000-8000-000000000001',
      locks,
      createChannel,
      onPrepare: () => {
        prepared.push('second');
        return Promise.resolve();
      },
      onCancel: () => undefined,
      onComplete: () => completed.push('second'),
    });
    await Promise.resolve();

    await expect(first.runExclusive(() => Promise.resolve('cleared'))).resolves.toBe('cleared');
    expect(prepared.sort()).toEqual(['first', 'second']);
    first.complete();
    expect(completed.sort()).toEqual(['first', 'second']);
    first.dispose();
    second.dispose();
  });

  it('fails closed when a tab misses the prepare broadcast and retains its shared lock', async () => {
    vi.useFakeTimers();
    const locks = new TestLocks();
    const isolatedChannels = () => {
      const channel = new TestChannel();
      channel.postMessage = () => undefined;
      return channel;
    };
    const first = new AccountExitBarrier({
      userId: '00000000-0000-4000-8000-000000000001',
      locks,
      createChannel: isolatedChannels,
      timeoutMs: 10,
      onPrepare: () => Promise.resolve(),
      onCancel: () => undefined,
      onComplete: () => undefined,
    });
    const missed = new AccountExitBarrier({
      userId: '00000000-0000-4000-8000-000000000001',
      locks,
      createChannel: isolatedChannels,
      onPrepare: () => Promise.resolve(),
      onCancel: () => undefined,
      onComplete: () => undefined,
    });
    await Promise.resolve();

    const exit = first.runExclusive(() => Promise.resolve());
    const rejected = expect(exit).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    first.dispose();
    missed.dispose();
  });

  it('cancels only the matching account and broadcasts no private content', () => {
    const locks = new TestLocks();
    const cancelled: string[] = [];
    const create = (userId: string, label: string) =>
      new AccountExitBarrier({
        userId,
        locks,
        createChannel,
        onPrepare: () => Promise.resolve(),
        onCancel: () => cancelled.push(label),
        onComplete: () => undefined,
      });
    const first = create('00000000-0000-4000-8000-000000000001', 'first');
    const second = create('00000000-0000-4000-8000-000000000001', 'second');
    const otherAccount = create('00000000-0000-4000-8000-000000000002', 'other');

    first.cancel();

    expect(cancelled.sort()).toEqual(['first', 'second']);
    expect(TestChannel.messages).toHaveLength(1);
    expect(Object.keys(TestChannel.messages[0] as object).sort()).toEqual([
      'requestId',
      'type',
      'userId',
    ]);
    first.dispose();
    second.dispose();
    otherAccount.dispose();
  });
});
