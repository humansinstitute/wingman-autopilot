import {
  createButton,
  createCapabilityPicker,
  createCard,
  createCheckbox,
  createInlineActions,
  createInput,
  createPlaceholderNote,
  createTextarea,
  setPanelVisible,
} from './agent-chat-shared-ui.js';

function createDisclosureSection(title, description, testId) {
  const details = document.createElement('details');
  details.style.cssText = 'margin-top:12px;padding:12px;border:1px solid var(--wm-border-muted, rgba(255,255,255,0.12));border-radius:10px;background:rgba(15,23,42,0.24);';
  if (testId) {
    details.setAttribute('data-testid', testId);
  }

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;font-weight:600;';
  summary.textContent = title;
  details.append(summary);

  const body = document.createElement('div');
  body.style.marginTop = '10px';

  if (description) {
    const note = document.createElement('p');
    note.className = 'wm-settings__port-note';
    note.style.margin = '0 0 8px 0';
    note.textContent = description;
    body.append(note);
  }

  details.append(body);
  return {
    element: details,
    body,
    setOpen(open) {
      details.open = Boolean(open);
    },
  };
}

export function createSubscriptionEditorCard() {
  const workspaceOwnerField = createInput('Workspace Owner npub', 'npub1workspace...', 'agent-chat-workspace-owner');
  const backendUrlField = createInput('Backend Base URL', 'https://tower.example.com', 'agent-chat-backend-url');
  const sourceAppField = createInput('Source App npub', 'npub1flightdeckapp...', 'agent-chat-source-app');

  const card = createCard(
    'Workspace Connection',
    'Save the shared workspace connection once. Agent dispatch reuses this same live subscription.',
  );
  const saveButton = createButton(
    'Save Connection',
    'agent-chat-save',
    'Create or refresh Agent Dispatch subscription',
  );
  const closeButton = createButton(
    'Done',
    'agent-chat-close-subscription-editor',
    'Close Agent Dispatch subscription editor',
  );

  card.append(
    workspaceOwnerField.row,
    backendUrlField.row,
    sourceAppField.row,
    createInlineActions(saveButton, closeButton),
  );
  setPanelVisible(card, false);

  return {
    card,
    saveButton,
    closeButton,
    workspaceOwnerField,
    backendUrlField,
    sourceAppField,
  };
}

export function createPrimaryAgentEditorCard() {
  const agentIdField = createInput('Agent ID', 'agent_wm21', 'agent-chat-agent-id');
  const labelField = createInput('Agent Label', 'Wingman 21', 'agent-chat-agent-label', true);
  const agentBotField = createInput('Agent Bot npub', 'npub1bot...', 'agent-chat-agent-bot');
  const agentWorkspaceField = createInput('Agent Workspace Owner npub', 'npub1workspace...', 'agent-chat-agent-workspace-owner');
  const agentGroupsField = createInput('Group npubs', 'Leave blank to use the bot subscription groups', 'agent-chat-agent-groups', true);
  const workingDirectoryField = createInput('Working Directory', '/Users/mini/code/wingmen', 'agent-chat-agent-directory');
  const chatPromptTemplateField = createTextarea(
    'Chat Prompt Template',
    'Editable chat dispatch prompt with {{placeholders}}',
    'agent-chat-chat-prompt-template',
    16,
  );
  const taskPromptTemplateField = createTextarea(
    'Task Prompt Template',
    'Editable task dispatch prompt with {{placeholders}}',
    'agent-chat-task-prompt-template',
    14,
  );
  const flowDispatchPromptTemplateField = createTextarea(
    'Flow Dispatch Prompt Template',
    'Editable flow dispatch prompt with {{placeholders}}',
    'agent-chat-flow-dispatch-prompt-template',
    14,
  );
  const taskReviewPromptTemplateField = createTextarea(
    'Task Review Prompt Template',
    'Editable task review prompt with {{placeholders}}',
    'agent-chat-task-review-prompt-template',
    14,
  );
  const approvalDispatchPromptTemplateField = createTextarea(
    'Approval Dispatch Prompt Template',
    'Editable approval dispatch prompt with {{placeholders}}',
    'agent-chat-approval-dispatch-prompt-template',
    12,
  );
  const capabilityPicker = createCapabilityPicker();
  const enabledField = createCheckbox('Enabled', 'agent-chat-agent-enabled', true);

  const card = createCard(
    'Primary Local Agent',
    'Keep one local agent and add capabilities to it. Only the core identity and dispatch roles stay in the main path.',
  );

  const intro = document.createElement('p');
  intro.className = 'wm-settings__port-note';
  intro.textContent = 'Use the short form below for the primary setup. Open the advanced sections only when you need routing overrides or prompt customization.';

  const identityNote = document.createElement('p');
  identityNote.className = 'wm-settings__port-note';
  identityNote.style.display = 'none';

  const identitySection = createDisclosureSection(
    'Manual identity fields',
    'Only use these if the shared connection is not available. When the workspace connection exists, the bot and workspace values are inherited automatically.',
    'agent-chat-identity-overrides',
  );
  identitySection.body.append(agentBotField.row, agentWorkspaceField.row);

  const advancedSection = createDisclosureSection(
    'Advanced routing overrides',
    'Leave groups blank in the normal path. Only override them if this agent should use a narrower routing scope than the shared connection.',
    'agent-chat-advanced-routing',
  );
  const agentGroupsNote = document.createElement('p');
  agentGroupsNote.className = 'wm-settings__port-note';
  agentGroupsNote.style.marginTop = '10px';
  agentGroupsNote.textContent = 'Leave group npubs blank to derive them from the bot groups already refreshed from Tower for this workspace subscription.';
  advancedSection.body.append(agentGroupsField.row, agentGroupsNote);

  const chatTemplateSection = createDisclosureSection(
    'Chat Dispatch Template',
    'Open this only when the default chat prompt contract needs an override for this local agent.',
    'agent-chat-chat-template-section',
  );
  chatTemplateSection.body.append(
    chatPromptTemplateField.row,
    createPlaceholderNote(
      'Chat placeholders',
      [
        '{{chat_runtime_event}}',
        '{{agent_id}}',
        '{{agent_label}}',
        '{{workspace_owner_npub}}',
        '{{channel_id}}',
        '{{thread_id}}',
        '{{bot_npub}}',
        '{{managed_by_npub}}',
        '{{session_id}}',
        '{{recent_turn_count}}',
        '{{participants}}',
        '{{recent_turns}}',
        '{{merge_package_json}}',
        '{{yoke_context_command}}',
        '{{yoke_history_command}}',
        '{{yoke_search_command}}',
        '{{yoke_related_command}}',
        '{{yoke_reply_current_command}}',
        '{{yoke_context_status}}',
        '{{chat_dispatch_instructions}}',
      ],
    ),
  );

  const taskTemplateSection = createDisclosureSection(
    'Task Dispatch Template',
    'Open this only when the default task dispatch prompt needs an override for this local agent.',
    'agent-chat-task-template-section',
  );
  taskTemplateSection.body.append(
    taskPromptTemplateField.row,
    createPlaceholderNote(
      'Task placeholders',
      [
        '{{dispatch_reason}}',
        '{{task_id}}',
        '{{flow_id}}',
        '{{flow_run_id}}',
        '{{flow_step}}',
        '{{scope_id}}',
        '{{scope_lineage}}',
        '{{title}}',
        '{{description}}',
      ],
    ),
  );

  const flowDispatchTemplateSection = createDisclosureSection(
    'Flow Dispatch Template',
    'Open this only when the kickoff orchestration prompt needs an override for this local agent.',
    'agent-chat-flow-template-section',
  );
  flowDispatchTemplateSection.body.append(
    flowDispatchPromptTemplateField.row,
    createPlaceholderNote(
      'Flow placeholders',
      [
        '{{dispatch_reason}}',
        '{{task_id}}',
        '{{flow_id}}',
        '{{scope_id}}',
        '{{scope_lineage}}',
        '{{title}}',
        '{{description}}',
      ],
    ),
  );

  const taskReviewTemplateSection = createDisclosureSection(
    'Task Review Template',
    'Open this only when the review-orchestration prompt needs an override for this local agent.',
    'agent-chat-task-review-template-section',
  );
  taskReviewTemplateSection.body.append(
    taskReviewPromptTemplateField.row,
    createPlaceholderNote(
      'Review placeholders',
      [
        '{{dispatch_reason}}',
        '{{task_id}}',
        '{{flow_id}}',
        '{{flow_run_id}}',
        '{{flow_step}}',
        '{{state}}',
        '{{title}}',
        '{{description}}',
      ],
    ),
  );

  const approvalDispatchTemplateSection = createDisclosureSection(
    'Approval Dispatch Template',
    'Open this only when the approval-continuation prompt needs an override for this local agent.',
    'agent-chat-approval-template-section',
  );
  approvalDispatchTemplateSection.body.append(
    approvalDispatchPromptTemplateField.row,
    createPlaceholderNote(
      'Approval placeholders',
      [
        '{{dispatch_reason}}',
        '{{approval_id}}',
        '{{flow_id}}',
        '{{flow_run_id}}',
        '{{flow_step}}',
        '{{approval_state}}',
      ],
    ),
  );

  const saveButton = createButton(
    'Save Agent',
    'agent-chat-save-agent',
    'Create or update local Agent Dispatch agent',
  );
  const closeButton = createButton(
    'Done',
    'agent-chat-close-agent-editor',
    'Close Agent Dispatch local agent editor',
  );

  card.append(
    agentIdField.row,
    labelField.row,
    workingDirectoryField.row,
    intro,
    identityNote,
    capabilityPicker.row,
    enabledField.row,
    identitySection.element,
    advancedSection.element,
    chatTemplateSection.element,
    taskTemplateSection.element,
    flowDispatchTemplateSection.element,
    taskReviewTemplateSection.element,
    approvalDispatchTemplateSection.element,
    createInlineActions(saveButton, closeButton),
  );
  setPanelVisible(card, false);

  function applyInheritedIdentity(subscription) {
    const inheritedBot = subscription?.botNpub?.trim() || '';
    const inheritedWorkspace = subscription?.workspaceOwnerNpub?.trim() || '';
    const hasInheritedIdentity = inheritedBot.length > 0 && inheritedWorkspace.length > 0;

    setPanelVisible(identitySection.element, !hasInheritedIdentity);
    identityNote.style.display = hasInheritedIdentity ? '' : 'none';

    if (hasInheritedIdentity) {
      identityNote.textContent = `This agent will reuse bot ${inheritedBot} and workspace ${inheritedWorkspace} from the shared connection.`;
      agentBotField.input.value = inheritedBot;
      agentWorkspaceField.input.value = inheritedWorkspace;
      identitySection.setOpen(false);
      return;
    }

    identityNote.textContent = '';
    identitySection.setOpen(true);
  }

  function setFocusState(focusField, options = {}) {
    const shouldOpenAdvanced = Boolean(options.openAdvanced);
    advancedSection.setOpen(shouldOpenAdvanced);
    chatTemplateSection.setOpen(focusField === 'chat-template');
    taskTemplateSection.setOpen(focusField === 'task-template');
    flowDispatchTemplateSection.setOpen(focusField === 'flow-template');
    taskReviewTemplateSection.setOpen(focusField === 'review-template');
    approvalDispatchTemplateSection.setOpen(focusField === 'approval-template');
  }

  return {
    card,
    saveButton,
    closeButton,
    agentIdField,
    labelField,
    agentBotField,
    agentWorkspaceField,
    agentGroupsField,
    workingDirectoryField,
    chatPromptTemplateField,
    taskPromptTemplateField,
    flowDispatchPromptTemplateField,
    taskReviewPromptTemplateField,
    approvalDispatchPromptTemplateField,
    capabilityPicker,
    enabledField,
    applyInheritedIdentity,
    setFocusState,
  };
}
