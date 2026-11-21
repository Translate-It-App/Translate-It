export function projectRateLimitQueueItems(queues, requests) {
  return Object.values(queues && typeof queues === 'object' ? queues : {}).flatMap(queue => Array.isArray(queue)
    ? queue.map(request => {
      const messageId = request?.options?.messageId ?? request?.messageId ?? null;
      const tracked = messageId === null ? null : requests?.get(messageId);
      return {
        messageId,
        sessionId: request?.options?.sessionId ?? request?.sessionId
          ?? tracked?.data?.sessionId ?? tracked?.metadata?.sessionId ?? null,
        context: request?.options?.context ?? request?.context ?? null,
      };
    })
    : []);
}
