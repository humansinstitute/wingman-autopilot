const LEGACY_AGENT_ORIGIN_TYPES = new Set([
  'scheduler',
  'nostr',
  'mg-task',
  'file-watcher',
  'agent-session',
]);

const PROGRAMMATIC_ORIGIN_TYPES = new Set([
  'cli',
  'delegate-bot',
]);

export const HOME_SESSION_GROUPS = Object.freeze([
  { id: 'my', label: 'My Sessions', emptyLabel: 'No human-started sessions.' },
  { id: 'task-dispatch', label: 'Task Dispatch', emptyLabel: 'No task dispatch sessions.' },
  { id: 'chat-dispatch', label: 'Chat Dispatch', emptyLabel: 'No chat dispatch sessions.' },
  { id: 'agent-sessions', label: 'Agent Sessions', emptyLabel: 'No agent-created sessions.' },
]);

function normaliseOriginType(session) {
  return typeof session?.origin?.type === 'string' ? session.origin.type.trim().toLowerCase() : '';
}

function normaliseMetadata(session) {
  return session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
}

export function isTaskDispatchSession(session) {
  const metadata = normaliseMetadata(session);
  const originType = normaliseOriginType(session);
  return (
    originType === 'mg-task' ||
    originType === 'agent-work' ||
    metadata.role === 'agent-work' ||
    metadata.bindingType === 'task' ||
    metadata.bindingType === 'flow_run'
  );
}

export function isChatDispatchSession(session) {
  const metadata = normaliseMetadata(session);
  const originType = normaliseOriginType(session);
  return (
    originType === 'agent-chat' ||
    metadata.role === 'agent-chat' ||
    metadata.routedBy === 'agent-chat'
  );
}

export function isAgentSession(session) {
  const metadata = normaliseMetadata(session);
  const originType = normaliseOriginType(session);
  return (
    metadata.AGENT === true ||
    PROGRAMMATIC_ORIGIN_TYPES.has(originType) ||
    LEGACY_AGENT_ORIGIN_TYPES.has(originType)
  );
}

export function getHomeSessionGroup(session) {
  if (isTaskDispatchSession(session)) {
    return 'task-dispatch';
  }
  if (isChatDispatchSession(session)) {
    return 'chat-dispatch';
  }
  if (isAgentSession(session)) {
    return 'agent-sessions';
  }
  return 'my';
}

export function filterSessionsForHomeGroup(sessions, groupId) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return [];
  }
  return sessions.filter((session) => getHomeSessionGroup(session) === groupId);
}

export function countSessionsByHomeGroup(sessions) {
  const counts = {
    my: 0,
    'task-dispatch': 0,
    'chat-dispatch': 0,
    'agent-sessions': 0,
  };

  if (!Array.isArray(sessions)) {
    return counts;
  }

  sessions.forEach((session) => {
    const groupId = getHomeSessionGroup(session);
    if (Object.prototype.hasOwnProperty.call(counts, groupId)) {
      counts[groupId] += 1;
    }
  });

  return counts;
}
