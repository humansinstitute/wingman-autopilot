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
