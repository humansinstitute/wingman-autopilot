export const DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE = [
  'Agent Chat runtime event: {{chat_runtime_event}}.',
  '',
  'Thread package:',
  '- agent_id: {{agent_id}}',
  '- agent_label: {{agent_label}}',
  '- workspace_owner_npub: {{workspace_owner_npub}}',
  '- channel_id: {{channel_id}}',
  '- thread_id: {{thread_id}}',
  '- bot_npub: {{bot_npub}}',
  '- managed_by_npub: {{managed_by_npub}}',
  '- session_id: {{session_id}}',
  '- recent_turn_count: {{recent_turn_count}}',
  '- participants: {{participants}}',
  '',
  'Recent turns:',
  '{{recent_turns}}',
  '',
  'Merge package JSON:',
  '```json',
  '{{merge_package_json}}',
  '```',
  '',
  'Yoke runtime commands:',
  '- Prime current context: {{yoke_context_command}}',
  '- More thread history: {{yoke_history_command}}',
  '- Search active channel: {{yoke_search_command}}',
  '- Related threads: {{yoke_related_command}}',
  '- Publish the thread reply yourself: {{yoke_reply_current_command}}',
  '',
  '{{yoke_context_status}}',
  '',
  'Instructions:',
  '{{chat_dispatch_instructions}}',
].join('\n');

export const DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE = [
  'Agent work dispatch.',
  'Dispatch reason: {{dispatch_reason}}.',
  'Task id: {{task_id}}',
  'Flow id: {{flow_id}}',
  'Flow run id: {{flow_run_id}}',
  'Flow step: {{flow_step}}',
  'Scope id: {{scope_id}}',
  'Scope lineage: {{scope_lineage}}',
  'Title: {{title}}',
  'Description: {{description}}',
  'Instructions:',
  '- Complete only the current actionable task.',
  '- Inspect the board before acting so you use current state rather than transcript memory.',
  '- Update the board with progress or completion when you finish meaningful work.',
  '- Stop if blocked, if a predecessor is unresolved, or if you are awaiting approval.',
].join('\n');

export const DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE = [
  'Agent flow dispatch.',
  'Dispatch reason: {{dispatch_reason}}.',
  'Task id: {{task_id}}',
  'Flow id: {{flow_id}}',
  'Scope id: {{scope_id}}',
  'Scope lineage: {{scope_lineage}}',
  'Title: {{title}}',
  'Description: {{description}}',
  'Instructions:',
  '- Claim the kickoff task exactly once and treat it as the parent task for the run.',
  '- Use the stable board wrapper, not ad hoc Yoke commands, for run instantiation.',
  '- Stamp one shared flow_run_id across the parent, child tasks, and approval records.',
  '- Create all child tasks and approval records up front, then leave blocked work in new and actionable work in ready.',
  '- Stop after the run graph and kickoff evidence are on the board.',
].join('\n');

export const DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE = [
  'Agent task review dispatch.',
  'Dispatch reason: {{dispatch_reason}}.',
  'Task id: {{task_id}}',
  'Flow id: {{flow_id}}',
  'Flow run id: {{flow_run_id}}',
  'Flow step: {{flow_step}}',
  'Task state: {{state}}',
  'Title: {{title}}',
  'Description: {{description}}',
  'Instructions:',
  '- Inspect the flow-run graph through the stable board wrapper.',
  '- Promote every newly-unblocked downstream task from new to ready in one pass.',
  '- Respect fan-out and fan-in by using predecessor completion, not step-number guesses.',
  '- Post concise board evidence describing which successors changed state.',
  '- Stop when no further downstream task can be promoted.',
].join('\n');

export const DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE = [
  'Agent approval dispatch.',
  'Dispatch reason: {{dispatch_reason}}.',
  'Approval id: {{approval_id}}',
  'Flow id: {{flow_id}}',
  'Flow run id: {{flow_run_id}}',
  'Flow step: {{flow_step}}',
  'Approval state: {{approval_state}}',
  'Instructions:',
  '- Continue only when the approval transition is approved and part of a live flow run.',
  '- Use the stable board wrapper to inspect the approval, linked tasks, and downstream graph.',
  '- Promote newly-unblocked downstream tasks from new to ready and record evidence on the board.',
  '- Stop if no further task is actionable after the approval decision.',
].join('\n');

export function getDefaultDispatchPromptTemplate(capability: string): string {
  if (capability === 'chat_intercept') {
    return DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE;
  }
  if (capability === 'task_dispatch') {
    return DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE;
  }
  if (capability === 'flow_dispatch') {
    return DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE;
  }
  if (capability === 'task_review') {
    return DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE;
  }
  if (capability === 'approval_dispatch') {
    return DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE;
  }
  return DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE;
}

export function normalisePromptTemplate(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}
