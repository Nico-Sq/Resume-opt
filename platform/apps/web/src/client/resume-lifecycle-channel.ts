const CHANNEL_PREFIX = 'resume-opt-lifecycle-v1';

interface ResumeDeletedEvent {
  type: 'resume-deleted';
  userId: string;
  resumeId: string;
}

function channelName(userId: string) {
  return `${CHANNEL_PREFIX}:${userId}`;
}

export function publishResumeDeleted(userId: string, resumeId: string) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(channelName(userId));
  channel.postMessage({ type: 'resume-deleted', userId, resumeId } satisfies ResumeDeletedEvent);
  channel.close();
}

export function subscribeToResumeDeleted(userId: string, resumeId: string, onDeleted: () => void) {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(channelName(userId));
  channel.onmessage = (message: MessageEvent<unknown>) => {
    const event = message.data;
    if (
      typeof event !== 'object' ||
      event === null ||
      !('type' in event) ||
      !('userId' in event) ||
      !('resumeId' in event) ||
      event.type !== 'resume-deleted' ||
      event.userId !== userId ||
      event.resumeId !== resumeId
    ) {
      return;
    }
    onDeleted();
  };
  return () => {
    channel.close();
  };
}
