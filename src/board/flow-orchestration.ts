import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { expandHomeDirectory } from '../server/path-utils';

export interface BoardFlowStep {
  stepNumber: number;
  type: 'job_dispatch' | 'approval';
  title: string;
  instruction: string;
  approvalMode: 'manual' | 'agent';
  approverWhitelist: string[];
  artifactsExpected: string[];
  briefTemplate: string;
  managerGuidance: string;
  workerGuidance: string;
  directoryOverride: string;
}

export interface BoardFlowRecord {
  flowId: string;
  title: string;
  description: string;
  steps: BoardFlowStep[];
}

export interface BoardTaskRecord {
  taskId: string;
  title: string;
  description: string;
  state: string | null;
  assignedTo: string | null;
  parentTaskId: string | null;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: number | null;
  predecessorTaskIds: string[];
  scopeId: string | null;
  scopeLineage: Array<string | null>;
  references: Array<{ type: string; id: string }>;
  tags: string[];
}

export interface BoardApprovalRecord {
  approvalId: string;
  title: string;
  flowId: string | null;
  flowRunId: string | null;
  flowStep: number | null;
  status: string | null;
  approvalMode: 'manual' | 'agent';
  taskIds: string[];
  brief: string;
  approverWhitelist: string[];
}

export interface BoardTaskCreateInput {
  title: string;
  description: string;
  state?: string | null;
  assignedTo?: string | null;
  parentTaskId?: string | null;
  predecessorTaskIds?: string[];
  flowId?: string | null;
  flowRunId?: string | null;
  flowStep?: number | null;
  scopeId?: string | null;
  tags?: string[];
}

export interface BoardApprovalCreateInput {
  title: string;
  flowId?: string | null;
  flowRunId?: string | null;
  flowStep?: number | null;
  taskIds?: string[];
  approvalMode?: 'manual' | 'agent';
  brief?: string;
  approverWhitelist?: string[];
}

export interface FlowBoard {
  getFlow(flowId: string): Promise<BoardFlowRecord>;
  getTask(taskId: string): Promise<BoardTaskRecord>;
  updateTask(taskId: string, patch: Partial<BoardTaskRecord> & {
    predecessorTaskIds?: string[];
    tags?: string[];
  }): Promise<BoardTaskRecord>;
  commentTask(taskId: string, body: string): Promise<void>;
  createTask(input: BoardTaskCreateInput): Promise<BoardTaskRecord>;
  createApproval(input: BoardApprovalCreateInput): Promise<BoardApprovalRecord>;
  getApproval?(approvalId: string): Promise<BoardApprovalRecord>;
  listFlowRunTasks(flowRunId: string): Promise<BoardTaskRecord[]>;
  listFlowRunApprovals(flowRunId: string): Promise<BoardApprovalRecord[]>;
}

export interface FlowDispatchResult {
  status: 'created' | 'already_instantiated';
  flowRunId: string;
  parentTaskId: string;
  createdTaskIds: string[];
  createdApprovalIds: string[];
}

export interface FlowContinuationResult {
  promotedTaskIds: string[];
}

const SATISFIED_TASK_STATES = new Set([
  'review',
  'done',
  'completed',
  'cancelled',
  'canceled',
  'archived',
]);

const APPROVAL_PREP_TAG = 'flow_approval_prep';

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compactStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => compactText(entry))
    .filter(Boolean);
}

function normaliseStepType(step: Record<string, unknown>): 'job_dispatch' | 'approval' {
  const explicit = compactText(step.type);
  if (explicit === 'approval') {
    return 'approval';
  }
  if (explicit === 'job_dispatch') {
    return 'job_dispatch';
  }
  const mode = compactText(step.approver_mode ?? step.approval_mode);
  if (mode === 'manual' || mode === 'agent') {
    return 'approval';
  }
  return 'job_dispatch';
}

function normaliseApprovalMode(step: Record<string, unknown>): 'manual' | 'agent' {
  return compactText(step.approver_mode ?? step.approval_mode) === 'agent' ? 'agent' : 'manual';
}

function normaliseApproverWhitelist(step: Record<string, unknown>): string[] {
  const whitelist = step.whitelist_approvers ?? step.approver_whitelist;
  if (!Array.isArray(whitelist)) {
    return [];
  }
  return whitelist
    .map((entry) => compactText(entry))
    .filter(Boolean);
}

function normaliseArtifactsExpected(step: Record<string, unknown>): string[] {
  return compactStringArray(step.artifacts_expected ?? step.artifactsExpected);
}

interface FlowRunContext {
  repoRoot: string | null;
  primaryWorkdir: string | null;
  docsDir: string | null;
  featureSlug: string;
  primaryArtifactPath: string | null;
  kickoffTitle: string;
  kickoffSummary: string | null;
  requestedBehavior: string[];
  boilerplateInstruction: string | null;
  sourceWorkspaceOwnerNpub: string | null;
  sourceScopeId: string | null;
  sourceFlowId: string | null;
  sourceChannelId: string | null;
  sourceThreadId: string | null;
  sourceCommitMessageId: string | null;
  crossRepoReviewTargets: string[];
}

function slugify(value: string): string {
  const collapsed = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return collapsed || 'flow';
}

function normalisePathCandidate(value: string): string | null {
  const trimmed = compactText(value);
  if (!trimmed) {
    return null;
  }
  const withoutLineSuffix = trimmed.replace(/:(\d+)(?::\d+)?$/, '');
  const cleaned = withoutLineSuffix
    .replace(/^[<('"`]+/, '')
    .replace(/[>)"'`,;:.]+$/, '');
  if (!cleaned) {
    return null;
  }
  const homeRelative = cleaned.replace(/^[Cc]ode\//, 'code/');
  const candidate = /^[Cc]ode\//.test(cleaned)
    ? `~/${homeRelative}`
    : cleaned;
  const expanded = expandHomeDirectory(candidate);
  if (!expanded.startsWith('/')) {
    return null;
  }
  return resolve(expanded);
}

function extractPathCandidates(text: string): string[] {
  const matches = text.match(/(?:~\/|\/Users\/|\/home\/|[Cc]ode\/)[^\s<>"'`),;]+/g) ?? [];
  return matches
    .map((candidate) => normalisePathCandidate(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function deriveRepoRootFromPath(candidate: string): string {
  if (candidate.endsWith('/docs')) {
    return dirname(candidate);
  }
  const docsIndex = candidate.indexOf('/docs/');
  if (docsIndex >= 0) {
    return candidate.slice(0, docsIndex);
  }
  if (/\.[a-z0-9]+$/i.test(candidate)) {
    return dirname(candidate);
  }
  return candidate;
}

function compactReferenceArray(value: unknown): Array<{ type: string; id: string }> {
  const parsed = (() => {
    if (Array.isArray(value)) {
      return value;
    }
    const text = compactText(value);
    if (!text.startsWith('[')) {
      return [];
    }
    try {
      const decoded = JSON.parse(text);
      return Array.isArray(decoded) ? decoded : [];
    } catch {
      return [];
    }
  })();
  const seen = new Set<string>();
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const type = compactText((entry as Record<string, unknown>).type);
    const id = compactText((entry as Record<string, unknown>).id);
    if (!type || !id) {
      return [];
    }
    const key = `${type}:${id}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ type, id }];
  });
}

function firstResolvedRepoRoot(values: string[]): string | null {
  for (const value of values) {
    const paths = extractPathCandidates(value);
    if (paths[0]) {
      return deriveRepoRootFromPath(paths[0]);
    }
  }
  return null;
}

function firstExplicitArtifactPath(values: string[]): string | null {
  for (const value of values) {
    for (const candidate of extractPathCandidates(value)) {
      if (!/\.[a-z0-9]+$/i.test(candidate)) {
        continue;
      }
      if (candidate.endsWith('.md') || candidate.endsWith('.mdx') || candidate.endsWith('.txt')) {
        return candidate;
      }
    }
  }
  return null;
}

function firstFeatureSlug(values: string[]): string | null {
  for (const value of values) {
    const explicit = value.match(/feature-([a-z0-9][a-z0-9_-]*)\.md/i)?.[1];
    if (explicit) {
      return slugify(explicit.replace(/_/g, '-'));
    }
    for (const candidate of extractPathCandidates(value)) {
      const filename = candidate.split('/').pop() ?? '';
      const basename = filename.replace(/\.[a-z0-9]+$/i, '');
      if (basename && !/^feature-<name>$/i.test(basename)) {
        return slugify(basename.replace(/^feature-/, '').replace(/_/g, '-'));
      }
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(description: string, heading: string, headings: string[]): string | null {
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(heading)}:\\n([\\s\\S]*?)(?=\\n(?:${headings.filter((value) => value !== heading).map(escapeRegExp).join('|')}):\\n|$)`,
    'i',
  );
  const match = pattern.exec(description);
  return compactText(match?.[1]);
}

function extractBullets(section: string | null): string[] {
  if (!section) {
    return [];
  }
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function extractMetadataValue(description: string, keys: string[]): string | null {
  for (const key of keys) {
    const pattern = new RegExp(`(?:^|\\n)-\\s*${escapeRegExp(key)}:\\s*(.+)$`, 'im');
    const match = pattern.exec(description);
    const value = compactText(match?.[1]);
    if (value) {
      return value;
    }
  }
  return null;
}

function firstReferenceId(task: BoardTaskRecord, type: string): string | null {
  return task.references.find((reference) => reference.type === type)?.id ?? null;
}

function lastReferenceId(task: BoardTaskRecord, type: string): string | null {
  const matches = task.references.filter((reference) => reference.type === type);
  return matches.length > 0 ? matches[matches.length - 1]?.id ?? null : null;
}

function buildMention(type: string, id: string, label: string): string {
  return `@[${label}](mention:${type}:${id})`;
}

function firstParagraph(value: string): string | null {
  const trimmed = compactText(value);
  if (!trimmed) {
    return null;
  }
  return compactText(trimmed.split(/\n\s*\n/, 1)[0]);
}

function isLikelyReviewTargetPath(candidate: string): boolean {
  if (!candidate.startsWith('/')) {
    return false;
  }
  if (candidate.endsWith('/docs')) {
    return false;
  }
  return /\/(src|docs|clis|mycode)\//.test(candidate) || /\.[a-z0-9]+$/i.test(candidate);
}

function buildCrossRepoReviewTargets(kickoffTask: BoardTaskRecord, excludePaths: string[] = []): string[] {
  const excluded = new Set(excludePaths.filter(Boolean));
  const targets: string[] = [];
  for (const candidate of extractPathCandidates(kickoffTask.description)) {
    if (!isLikelyReviewTargetPath(candidate)) {
      continue;
    }
    if (excluded.has(candidate)) {
      continue;
    }
    if (targets.includes(candidate)) {
      continue;
    }
    targets.push(candidate);
  }
  return targets.slice(0, 8);
}

function resolveFlowRunContext(kickoffTask: BoardTaskRecord, flow: BoardFlowRecord): FlowRunContext {
  const headings = [
    'Requested flow behavior',
    'Boilerplate instruction',
    'Source thread metadata',
    'Chat thread transcript',
    'Resolved run contract',
    'Implementation intent',
    'Resolved live flow run summary',
  ];
  const requestedBehavior = extractBullets(extractSection(kickoffTask.description, 'Requested flow behavior', headings));
  const boilerplateInstruction = extractSection(kickoffTask.description, 'Boilerplate instruction', headings);
  const flowTexts = [
    kickoffTask.description,
    kickoffTask.title,
    flow.description,
    flow.title,
    ...flow.steps.flatMap((step) => [
      step.instruction,
      step.briefTemplate,
      step.managerGuidance,
      step.workerGuidance,
      step.directoryOverride,
    ]),
  ].filter(Boolean);
  const repoRoot = firstResolvedRepoRoot(flowTexts);
  const docsDir = repoRoot ? join(repoRoot, 'docs') : null;
  const explicitArtifactPath = firstExplicitArtifactPath(flowTexts);
  const featureSlug = firstFeatureSlug(flowTexts)
    ?? slugify(kickoffTask.title || flow.title || 'flow');
  const primaryArtifactPath = explicitArtifactPath
    ? explicitArtifactPath
    : docsDir
      ? join(docsDir, `feature-${featureSlug}.md`)
      : null;
  const sourceWorkspaceOwnerNpub = extractMetadataValue(kickoffTask.description, ['workspace_owner_npub']);
  const sourceScopeId = extractMetadataValue(kickoffTask.description, ['source_scope_id'])
    ?? firstReferenceId(kickoffTask, 'scope');
  const sourceFlowId = extractMetadataValue(kickoffTask.description, ['selected_flow_id', 'flow_id'])
    ?? firstReferenceId(kickoffTask, 'flow')
    ?? flow.flowId;
  const sourceChannelId = extractMetadataValue(kickoffTask.description, ['channel_id'])
    ?? firstReferenceId(kickoffTask, 'channel');
  const sourceThreadId = extractMetadataValue(kickoffTask.description, ['thread_id', 'source_thread_id'])
    ?? firstReferenceId(kickoffTask, 'message');
  const sourceCommitMessageId = extractMetadataValue(kickoffTask.description, [
    'commit_message_id',
    'source_commit_message_id',
    'selected_message_id',
    'source_message_id',
  ]) ?? (() => {
    const candidate = lastReferenceId(kickoffTask, 'message');
    return candidate && candidate !== sourceThreadId ? candidate : null;
  })();
  return {
    repoRoot,
    primaryWorkdir: repoRoot,
    docsDir,
    featureSlug,
    primaryArtifactPath,
    kickoffTitle: kickoffTask.title,
    kickoffSummary: firstParagraph(kickoffTask.description),
    requestedBehavior,
    boilerplateInstruction,
    sourceWorkspaceOwnerNpub,
    sourceScopeId,
    sourceFlowId,
    sourceChannelId,
    sourceThreadId,
    sourceCommitMessageId,
    crossRepoReviewTargets: buildCrossRepoReviewTargets(kickoffTask, primaryArtifactPath ? [primaryArtifactPath] : []),
  };
}

function resolveStepWorkdir(context: FlowRunContext, step: BoardFlowStep): string | null {
  const override = compactText(step.directoryOverride);
  if (override) {
    const absoluteOverride = normalisePathCandidate(override);
    if (absoluteOverride) {
      return absoluteOverride;
    }
    if (context.repoRoot) {
      return resolve(context.repoRoot, override);
    }
  }
  return context.primaryWorkdir;
}

function resolveStepArtifactPath(context: FlowRunContext, step: BoardFlowStep): string | null {
  const textValues = [step.instruction, step.briefTemplate, step.managerGuidance, step.workerGuidance];
  const explicit = firstExplicitArtifactPath(textValues);
  if (explicit) {
    return explicit;
  }
  if (!context.primaryArtifactPath) {
    return null;
  }
  const mentionsArtifact = /feature-<name>\.md|<project directory>|artifacts?/i.test(textValues.join('\n'))
    || step.artifactsExpected.includes('document');
  return mentionsArtifact ? context.primaryArtifactPath : null;
}

function materialiseFlowText(value: string, context: FlowRunContext, step?: BoardFlowStep): string {
  let output = compactText(value);
  if (!output) {
    return '';
  }
  const workdir = step ? resolveStepWorkdir(context, step) : context.primaryWorkdir;
  const artifactPath = step ? resolveStepArtifactPath(context, step) : context.primaryArtifactPath;
  if (context.repoRoot) {
    output = output.replace(/<project directory>/gi, context.repoRoot);
  }
  if (context.docsDir) {
    output = output.replace(/<docs directory>/gi, context.docsDir);
  }
  if (artifactPath) {
    output = output.replace(/feature-<name>\.md/gi, artifactPath.split('/').pop() ?? 'artifact.md');
    output = output.replace(/(?:<project directory>\/)?docs\/feature-<name>\.md/gi, artifactPath);
  }
  if (workdir) {
    output = output.replace(/<working directory>/gi, workdir);
  }
  return output;
}

function buildRunContractLines(step: BoardFlowStep, context: FlowRunContext): string[] {
  const lines: string[] = [];
  const workdir = resolveStepWorkdir(context, step);
  const artifactPath = resolveStepArtifactPath(context, step);
  lines.push(`Flow run id: {{flow_run_id}}`);
  if (workdir) {
    lines.push(`Working directory: ${workdir}`);
  }
  if (context.repoRoot && context.repoRoot !== workdir) {
    lines.push(`Repo root: ${context.repoRoot}`);
  }
  if (context.docsDir) {
    lines.push(`Docs directory: ${context.docsDir}`);
  }
  if (artifactPath) {
    lines.push(`Primary artifact: ${artifactPath}`);
  }
  if (step.artifactsExpected.length > 0) {
    const expectedArtifacts = step.artifactsExpected.map((artifact) => {
      if (artifact === 'document' && artifactPath) {
        return `Feature brief at ${artifactPath}`;
      }
      return artifact;
    });
    lines.push(`Expected artifacts: ${expectedArtifacts.join(', ')}`);
  }
  if (step.managerGuidance) {
    lines.push(`Manager guidance: ${materialiseFlowText(step.managerGuidance, context, step)}`);
  }
  if (step.workerGuidance) {
    lines.push(`Worker guidance: ${materialiseFlowText(step.workerGuidance, context, step)}`);
  }
  return lines;
}

function materialiseRunContractLines(lines: string[], flowRunId: string): string[] {
  return lines.map((line) => line.replace('{{flow_run_id}}', flowRunId));
}

function buildKickoffContextSections(context: FlowRunContext): string[] {
  const sections: string[] = [];
  if (context.kickoffSummary || context.kickoffTitle) {
    sections.push([
      'Feature context:',
      `- ${context.kickoffSummary ?? context.kickoffTitle}`,
    ].join('\n'));
  }
  if (context.requestedBehavior.length > 0) {
    sections.push([
      'Requested behavior:',
      ...context.requestedBehavior.map((line) => `- ${line}`),
    ].join('\n'));
  }
  if (context.boilerplateInstruction) {
    sections.push([
      'Boilerplate dispatch instruction:',
      context.boilerplateInstruction,
    ].join('\n'));
  }
  const provenanceLines = [
    context.sourceScopeId ? `- Source scope: ${buildMention('scope', context.sourceScopeId, 'source scope')}` : '',
    context.sourceFlowId ? `- Selected flow: ${buildMention('flow', context.sourceFlowId, 'selected flow')}` : '',
    context.sourceChannelId ? `- Channel: ${buildMention('channel', context.sourceChannelId, 'Flight Deck chat')}` : '',
    context.sourceThreadId ? `- Thread: ${buildMention('message', context.sourceThreadId, 'thread root')}` : '',
    context.sourceCommitMessageId ? `- Commit message: ${buildMention('message', context.sourceCommitMessageId, 'dispatch request')}` : '',
  ].filter(Boolean);
  if (provenanceLines.length > 0) {
    sections.push(['Source provenance:', ...provenanceLines].join('\n'));
  }
  if (context.crossRepoReviewTargets.length > 0) {
    sections.push([
      'Cross-repo review targets:',
      ...context.crossRepoReviewTargets.map((path) => `- ${path}`),
    ].join('\n'));
  }
  return sections;
}

function buildStepDescription(
  step: BoardFlowStep,
  context: FlowRunContext,
  flowRunId: string,
  mode: 'job' | 'approval',
): string {
  const sections: string[] = [];
  const baseInstruction = materialiseFlowText(step.instruction || step.title, context, step);
  if (baseInstruction) {
    sections.push(baseInstruction);
  }
  if (mode === 'approval') {
    sections.push([
      'Approval prep task. Keep this task assigned to the agent while it is actionable.',
      'Do not hand this task to the human approver until the approval brief, recommendation, exact artifact path, and key risks or open questions are prepared.',
    ].join('\n'));
  }
  sections.push(...buildKickoffContextSections(context));
  const runContractLines = materialiseRunContractLines(buildRunContractLines(step, context), flowRunId);
  if (runContractLines.length > 0) {
    sections.push(['Run contract:', ...runContractLines.map((line) => `- ${line}`)].join('\n'));
  }
  const acceptanceLines = mode === 'approval'
    ? [
      'Prepare the approval package on the exact artifact path above.',
      'Summarise the recommendation, evidence, risks, and open questions before reassigning to the human approver.',
      'Do not promote downstream tasks directly from this task.',
    ]
    : [
      'Use the recorded working directory and artifact path above.',
      'Keep the deliverable aligned to the requested behavior and source provenance.',
      'Complete only this step; downstream flow steps remain separate tasks.',
    ];
  sections.push(['Acceptance for this step:', ...acceptanceLines.map((line) => `- ${line}`)].join('\n'));
  return sections.join('\n\n');
}

function buildApprovalBrief(step: BoardFlowStep, context: FlowRunContext, flowRunId: string): string {
  const base = materialiseFlowText(step.briefTemplate || step.instruction || step.title, context, step);
  const sections = [
    base,
    ...buildKickoffContextSections(context),
  ].filter(Boolean);
  const lines = materialiseRunContractLines(buildRunContractLines(step, context), flowRunId)
    .filter((line) =>
      line.startsWith('Flow run id:')
      || line.startsWith('Working directory:')
      || line.startsWith('Primary artifact:')
      || line.startsWith('Expected artifacts:'),
    );
  return [
    ...sections,
    'Approval package requirements:',
    '- Confirm the final artifact path is correct and already populated.',
    '- Include a recommendation, key evidence, and unresolved risks or open questions.',
    '- Hand the linked approval-prep task to the whitelisted human approver only after the package is complete.',
    'Review package:',
    ...lines.map((line) => `- ${line}`),
  ].join('\n\n');
}

function findApprovalForTask(approvals: BoardApprovalRecord[], task: BoardTaskRecord): BoardApprovalRecord | null {
  return approvals.find((approval) =>
    approval.taskIds.includes(task.taskId)
    || (approval.flowStep != null && task.flowStep != null && approval.flowStep === task.flowStep),
  ) ?? null;
}

export function normaliseFlowRecord(raw: Record<string, unknown>): BoardFlowRecord {
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  return {
    flowId: compactText(raw.record_id) || compactText(raw.flow_id),
    title: compactText(raw.title) || 'Flow',
    description: compactText(raw.description),
    steps: steps
      .map((step) => {
        const value = step && typeof step === 'object' ? step as Record<string, unknown> : {};
        const stepNumber = Number(value.step_number);
        return {
          stepNumber: Number.isFinite(stepNumber) ? stepNumber : 0,
          type: normaliseStepType(value),
          title: compactText(value.title) || `Step ${stepNumber}`,
          instruction: compactText(value.instruction ?? value.description ?? value.goals),
          approvalMode: normaliseApprovalMode(value),
          approverWhitelist: normaliseApproverWhitelist(value),
          artifactsExpected: normaliseArtifactsExpected(value),
          briefTemplate: compactText(value.brief_template ?? value.briefTemplate),
          managerGuidance: compactText(value.manager_guidance ?? value.managerGuidance),
          workerGuidance: compactText(value.worker_guidance ?? value.workerGuidance),
          directoryOverride: compactText(value.directory_override ?? value.directoryOverride),
        };
      })
      .filter((step) => step.stepNumber > 0)
      .sort((left, right) => left.stepNumber - right.stepNumber),
  };
}

function normaliseTags(tags: string[] | null | undefined, additions: string[]): string[] {
  return Array.from(new Set([...(tags ?? []), ...additions].filter(Boolean))).sort();
}

function formatStepTitle(step: BoardFlowStep): string {
  return `${String(step.stepNumber).padStart(2, '0')} - ${step.title}`;
}

function enrichParentDescription(input: {
  kickoffTask: BoardTaskRecord;
  flow: BoardFlowRecord;
  flowRunId: string;
  context: FlowRunContext;
}): string {
  const existing = compactText(input.kickoffTask.description);
  const planLines = input.flow.steps.map((step) => {
    const parts = [`- ${formatStepTitle(step)} (${step.type})`];
    const workdir = resolveStepWorkdir(input.context, step);
    const artifactPath = resolveStepArtifactPath(input.context, step);
    if (workdir) {
      parts.push(`workdir=${workdir}`);
    }
    if (artifactPath) {
      parts.push(`artifact=${artifactPath}`);
    }
    return parts.join(' | ');
  });
  const sections = [
    existing,
    `Flow Dispatch parent task for "${input.flow.title}".`,
    `Flow run id: ${input.flowRunId}`,
    input.context.repoRoot ? `Repo root: ${input.context.repoRoot}` : '',
    input.context.primaryArtifactPath ? `Primary artifact: ${input.context.primaryArtifactPath}` : '',
    input.context.sourceChannelId ? `Source channel: ${buildMention('channel', input.context.sourceChannelId, 'Flight Deck chat')}` : '',
    input.context.sourceThreadId ? `Source thread: ${buildMention('message', input.context.sourceThreadId, 'thread root')}` : '',
    input.context.sourceCommitMessageId ? `Source commit message: ${buildMention('message', input.context.sourceCommitMessageId, 'dispatch request')}` : '',
    'Planned run graph:',
    ...planLines,
  ].filter(Boolean);
  return sections.join('\n\n');
}

function isTaskSatisfied(task: BoardTaskRecord | null | undefined): boolean {
  return Boolean(task?.state && SATISFIED_TASK_STATES.has(task.state));
}

function hasSatisfiedPredecessors(task: BoardTaskRecord, taskMap: Map<string, BoardTaskRecord>): boolean {
  return task.predecessorTaskIds.every((taskId) => isTaskSatisfied(taskMap.get(taskId)));
}

export async function instantiateFlowRun(board: FlowBoard, kickoffTaskId: string): Promise<FlowDispatchResult> {
  const kickoffTask = await board.getTask(kickoffTaskId);
  if (!kickoffTask.flowId) {
    throw new Error(`Kickoff task ${kickoffTaskId} is missing flowId.`);
  }

  const latestKickoff = await board.getTask(kickoffTaskId);
  if (latestKickoff.flowRunId) {
    return {
      status: 'already_instantiated',
      flowRunId: latestKickoff.flowRunId,
      parentTaskId: latestKickoff.taskId,
      createdTaskIds: [],
      createdApprovalIds: [],
    };
  }

  const flow = await board.getFlow(kickoffTask.flowId);
  if (flow.steps.length === 0) {
    throw new Error(`Flow ${flow.flowId} has no steps.`);
  }

  const flowRunId = randomUUID();
  const context = resolveFlowRunContext(kickoffTask, flow);
  const parentTask = await board.updateTask(kickoffTask.taskId, {
    state: 'in_progress',
    flowRunId,
    tags: normaliseTags(kickoffTask.tags, ['flow_parent']),
    description: enrichParentDescription({
      kickoffTask,
      flow,
      flowRunId,
      context,
    }),
  });

  const createdTaskIds: string[] = [];
  const createdApprovalIds: string[] = [];
  let predecessorTaskIds: string[] = [];

  for (const step of flow.steps) {
    if (step.type === 'approval') {
      const approvalTask = await board.createTask({
        title: formatStepTitle(step),
        description: buildStepDescription(step, context, flowRunId, 'approval') || 'Approval gate.',
        state: predecessorTaskIds.length === 0 ? 'ready' : 'new',
        assignedTo: parentTask.assignedTo,
        parentTaskId: parentTask.taskId,
        predecessorTaskIds,
        flowId: flow.flowId,
        flowRunId,
        flowStep: step.stepNumber,
        scopeId: parentTask.scopeId,
        tags: ['flow_approval', APPROVAL_PREP_TAG, 'flow_step'],
      });
      const approval = await board.createApproval({
        title: formatStepTitle(step),
        flowId: flow.flowId,
        flowRunId,
        flowStep: step.stepNumber,
        taskIds: [approvalTask.taskId],
        approvalMode: step.approvalMode,
        brief: buildApprovalBrief(step, context, flowRunId) || step.title,
        approverWhitelist: step.approverWhitelist,
      });
      createdTaskIds.push(approvalTask.taskId);
      createdApprovalIds.push(approval.approvalId);
      predecessorTaskIds = [approvalTask.taskId];
      continue;
    }

    const childTask = await board.createTask({
      title: formatStepTitle(step),
      description: buildStepDescription(step, context, flowRunId, 'job'),
      state: predecessorTaskIds.length === 0 ? 'ready' : 'new',
      assignedTo: parentTask.assignedTo,
      parentTaskId: parentTask.taskId,
      predecessorTaskIds,
      flowId: flow.flowId,
      flowRunId,
      flowStep: step.stepNumber,
      scopeId: parentTask.scopeId,
      tags: ['flow_step'],
    });
    createdTaskIds.push(childTask.taskId);
    predecessorTaskIds = [childTask.taskId];
  }

  await board.commentTask(
    parentTask.taskId,
    `Flow Dispatch instantiated run ${flowRunId} with ${createdTaskIds.length} child task(s) and ${createdApprovalIds.length} approval record(s).`,
  );

  return {
    status: 'created',
    flowRunId,
    parentTaskId: parentTask.taskId,
    createdTaskIds,
    createdApprovalIds,
  };
}

export async function continueFlowAfterTaskReview(
  board: FlowBoard,
  reviewedTaskId: string,
): Promise<FlowContinuationResult> {
  const reviewedTask = await board.getTask(reviewedTaskId);
  if (!reviewedTask.flowRunId) {
    throw new Error(`Task ${reviewedTaskId} is not part of a flow run.`);
  }
  if (reviewedTask.tags.includes('flow_approval')) {
    const approvals = await board.listFlowRunApprovals(reviewedTask.flowRunId);
    const approval = findApprovalForTask(approvals, reviewedTask);
    const nextAssignee = approval?.approverWhitelist[0] ?? null;
    await board.updateTask(reviewedTask.taskId, {
      assignedTo: nextAssignee,
      state: 'review',
    });
    await board.commentTask(
      reviewedTask.taskId,
      nextAssignee
        ? `Task Review prepared the approval package and handed this task to ${nextAssignee} for human review.`
        : 'Task Review prepared the approval package. No explicit approver was whitelisted, so the task is now waiting in review.',
    );
    return { promotedTaskIds: [] };
  }
  const tasks = await board.listFlowRunTasks(reviewedTask.flowRunId);
  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));
  const promotedTaskIds: string[] = [];

  for (const task of tasks) {
    if (task.state !== 'new') {
      continue;
    }
    if (!hasSatisfiedPredecessors(task, taskMap)) {
      continue;
    }
    const updated = await board.updateTask(task.taskId, { state: 'ready' });
    taskMap.set(updated.taskId, updated);
    promotedTaskIds.push(updated.taskId);
  }

  if (promotedTaskIds.length > 0) {
    await board.commentTask(
      reviewedTask.taskId,
      `Task Review promoted ${promotedTaskIds.length} downstream task(s) to ready: ${promotedTaskIds.join(', ')}.`,
    );
  }

  return { promotedTaskIds };
}

export async function continueFlowAfterApproval(
  board: FlowBoard,
  approval: BoardApprovalRecord,
): Promise<FlowContinuationResult> {
  if (!approval.flowRunId) {
    throw new Error(`Approval ${approval.approvalId} is not part of a flow run.`);
  }

  for (const taskId of approval.taskIds) {
    await board.updateTask(taskId, { state: 'done' });
  }

  const tasks = await board.listFlowRunTasks(approval.flowRunId);
  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));
  const promotedTaskIds: string[] = [];

  for (const task of tasks) {
    if (task.state !== 'new') {
      continue;
    }
    if (!hasSatisfiedPredecessors(task, taskMap)) {
      continue;
    }
    const updated = await board.updateTask(task.taskId, { state: 'ready' });
    taskMap.set(updated.taskId, updated);
    promotedTaskIds.push(updated.taskId);
  }

  if (approval.taskIds[0]) {
    await board.commentTask(
      approval.taskIds[0],
      promotedTaskIds.length > 0
        ? `Approval Dispatch promoted ${promotedTaskIds.length} downstream task(s) to ready: ${promotedTaskIds.join(', ')}.`
        : 'Approval Dispatch found no newly-unblocked downstream tasks.',
    );
  }

  return { promotedTaskIds };
}
