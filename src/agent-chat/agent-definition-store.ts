import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

import { databaseFile } from '../storage/message-store';
import {
  DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
  normalisePromptTemplate,
} from './prompt-templates';
import type {
  AgentCapability,
  AgentDefinitionRecord,
} from './types';

const DEFAULT_DB_PATH = databaseFile;

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function serialiseJsonArray(values: string[]): string {
  return JSON.stringify(values);
}

function normaliseDirectChat(record: AgentDefinitionRecord): NonNullable<AgentDefinitionRecord['directChat']> {
  const profile = record.directChat;
  const idleRetention = Number(profile?.idleRetentionMinutes ?? 60);
  return {
    enabled: profile?.enabled ?? false,
    sessionAgent: profile?.sessionAgent?.trim() || null,
    directory: profile?.directory?.trim() || record.workingDirectory,
    model: profile?.model?.trim() || null,
    idleRetentionMinutes: Number.isFinite(idleRetention) ? Math.max(1, Math.floor(idleRetention)) : 60,
  };
}

function normaliseCapabilities(values: string[]): AgentCapability[] {
  const set = new Set<AgentCapability>();
  for (const value of values) {
    if (value === 'chat_intercept') {
      set.add(value);
      continue;
    }
    if (value === 'task_dispatch') {
      set.add(value);
      continue;
    }
    if (value === 'comment_dispatch') {
      set.add(value);
      continue;
    }
    if (value === 'flow_dispatch') {
      set.add(value);
      continue;
    }
    if (value === 'task_review') {
      set.add(value);
      continue;
    }
    if (value === 'approval_dispatch') {
      set.add(value);
    }
  }
  return set.size > 0 ? [...set] : ['chat_intercept'];
}

function normaliseGroupNpubs(values: string[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
  }
  return [...set].sort();
}

class AgentDefinitionStore {
  private readonly db: Database;

  constructor(filePath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.initialise();
  }

  listForManagerNpub(npub: string): AgentDefinitionRecord[] {
    return this.listWhere('managed_by_npub = ?1', [npub]);
  }

  listByWorkspaceAndBot(workspaceOwnerNpub: string, botNpub: string): AgentDefinitionRecord[] {
    return this.listWhere(
      'workspace_owner_npub = ?1 AND bot_npub = ?2',
      [workspaceOwnerNpub, botNpub],
    );
  }

  getByAgentId(agentId: string): AgentDefinitionRecord | null {
    return this.getWhere('agent_id = ?1', [agentId]);
  }

  save(record: AgentDefinitionRecord): AgentDefinitionRecord {
    this.db.query(
      `INSERT INTO agent_definitions (
         agent_id, label, bot_npub, workspace_owner_npub, group_npubs_json,
         working_directory, capabilities_json, chat_prompt_template, task_prompt_template,
         flow_dispatch_prompt_template, task_review_prompt_template, approval_dispatch_prompt_template,
         direct_chat_json, enabled, created_at, updated_at, managed_by_npub
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
       )
       ON CONFLICT(agent_id) DO UPDATE SET
         label = excluded.label,
         bot_npub = excluded.bot_npub,
         workspace_owner_npub = excluded.workspace_owner_npub,
         group_npubs_json = excluded.group_npubs_json,
         working_directory = excluded.working_directory,
         capabilities_json = excluded.capabilities_json,
         chat_prompt_template = excluded.chat_prompt_template,
         task_prompt_template = excluded.task_prompt_template,
         flow_dispatch_prompt_template = excluded.flow_dispatch_prompt_template,
         task_review_prompt_template = excluded.task_review_prompt_template,
         approval_dispatch_prompt_template = excluded.approval_dispatch_prompt_template,
         direct_chat_json = excluded.direct_chat_json,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at,
         managed_by_npub = excluded.managed_by_npub`,
    ).run(
      record.agentId,
      record.label,
      record.botNpub,
      record.workspaceOwnerNpub,
      serialiseJsonArray(record.groupNpubs),
      record.workingDirectory,
      serialiseJsonArray(record.capabilities),
      normalisePromptTemplate(record.chatPromptTemplate, DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE),
      normalisePromptTemplate(record.taskPromptTemplate, DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE),
      normalisePromptTemplate(record.flowDispatchPromptTemplate, DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE),
      normalisePromptTemplate(record.taskReviewPromptTemplate, DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE),
      normalisePromptTemplate(record.approvalDispatchPromptTemplate, DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE),
      JSON.stringify(normaliseDirectChat(record)),
      record.enabled ? 1 : 0,
      record.createdAt,
      record.updatedAt,
      record.managedByNpub,
    );
    return this.getByAgentId(record.agentId) ?? record;
  }

  delete(agentId: string): boolean {
    const result = this.db.query('DELETE FROM agent_definitions WHERE agent_id = ?1').run(agentId);
    return result.changes > 0;
  }

  private listWhere(whereClause: string, args: SQLQueryBindings[]): AgentDefinitionRecord[] {
    return this.db
      .query(
        `SELECT
           agent_id,
           label,
           bot_npub,
           workspace_owner_npub,
           group_npubs_json,
           working_directory,
           capabilities_json,
           chat_prompt_template,
           task_prompt_template,
           flow_dispatch_prompt_template,
           task_review_prompt_template,
           approval_dispatch_prompt_template,
           direct_chat_json,
           enabled,
           created_at,
           updated_at,
           managed_by_npub
         FROM agent_definitions
         WHERE ${whereClause}
         ORDER BY updated_at DESC, agent_id ASC`,
      )
      .all(...args)
      .map((row) => this.mapRow(row as Record<string, string | number | null>));
  }

  private getWhere(whereClause: string, args: SQLQueryBindings[]): AgentDefinitionRecord | null {
    const row = this.db
      .query(
        `SELECT
           agent_id,
           label,
           bot_npub,
           workspace_owner_npub,
           group_npubs_json,
           working_directory,
           capabilities_json,
           chat_prompt_template,
           task_prompt_template,
           flow_dispatch_prompt_template,
           task_review_prompt_template,
           approval_dispatch_prompt_template,
           direct_chat_json,
           enabled,
           created_at,
           updated_at,
           managed_by_npub
         FROM agent_definitions
         WHERE ${whereClause}
         LIMIT 1`,
      )
      .get(...args) as Record<string, string | number | null> | null;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, string | number | null>): AgentDefinitionRecord {
    return {
      agentId: String(row.agent_id ?? ''),
      label: String(row.label ?? ''),
      botNpub: String(row.bot_npub ?? ''),
      workspaceOwnerNpub: String(row.workspace_owner_npub ?? ''),
      groupNpubs: normaliseGroupNpubs(parseJsonArray(typeof row.group_npubs_json === 'string' ? row.group_npubs_json : null)),
      workingDirectory: String(row.working_directory ?? ''),
      directChat: (() => {
        try {
          const parsed = JSON.parse(typeof row.direct_chat_json === 'string' ? row.direct_chat_json : '{}') as Record<string, unknown>;
          return normaliseDirectChat({
            workingDirectory: String(row.working_directory ?? ''),
            directChat: {
              enabled: parsed.enabled === true,
              sessionAgent: typeof parsed.sessionAgent === 'string' ? parsed.sessionAgent : null,
              directory: typeof parsed.directory === 'string' ? parsed.directory : '',
              model: typeof parsed.model === 'string' ? parsed.model : null,
              idleRetentionMinutes: Number(parsed.idleRetentionMinutes ?? 60),
            },
          } as AgentDefinitionRecord);
        } catch {
          return normaliseDirectChat({ workingDirectory: String(row.working_directory ?? '') } as AgentDefinitionRecord);
        }
      })(),
      capabilities: normaliseCapabilities(parseJsonArray(typeof row.capabilities_json === 'string' ? row.capabilities_json : null)),
      chatPromptTemplate: normalisePromptTemplate(
        typeof row.chat_prompt_template === 'string' ? row.chat_prompt_template : null,
        DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
      ),
      taskPromptTemplate: normalisePromptTemplate(
        typeof row.task_prompt_template === 'string' ? row.task_prompt_template : null,
        DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
      ),
      flowDispatchPromptTemplate: normalisePromptTemplate(
        typeof row.flow_dispatch_prompt_template === 'string' ? row.flow_dispatch_prompt_template : null,
        DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
      ),
      taskReviewPromptTemplate: normalisePromptTemplate(
        typeof row.task_review_prompt_template === 'string' ? row.task_review_prompt_template : null,
        DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
      ),
      approvalDispatchPromptTemplate: normalisePromptTemplate(
        typeof row.approval_dispatch_prompt_template === 'string' ? row.approval_dispatch_prompt_template : null,
        DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
      ),
      enabled: Number(row.enabled ?? 0) === 1,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      managedByNpub: typeof row.managed_by_npub === 'string' ? row.managed_by_npub : null,
    };
  }

  private initialise() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_definitions (
        agent_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        bot_npub TEXT NOT NULL,
        workspace_owner_npub TEXT NOT NULL,
        group_npubs_json TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        chat_prompt_template TEXT,
        task_prompt_template TEXT,
        flow_dispatch_prompt_template TEXT,
        task_review_prompt_template TEXT,
        approval_dispatch_prompt_template TEXT,
        direct_chat_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        managed_by_npub TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_definitions_manager
        ON agent_definitions(managed_by_npub, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_definitions_workspace_bot
        ON agent_definitions(workspace_owner_npub, bot_npub, enabled);
    `);
    const columns = this.db.query('PRAGMA table_info(agent_definitions)').all() as Array<{ name?: string }>;
    const hasChatTemplate = columns.some((row) => row.name === 'chat_prompt_template');
    const hasTaskTemplate = columns.some((row) => row.name === 'task_prompt_template');
    const hasFlowDispatchTemplate = columns.some((row) => row.name === 'flow_dispatch_prompt_template');
    const hasTaskReviewTemplate = columns.some((row) => row.name === 'task_review_prompt_template');
    const hasApprovalDispatchTemplate = columns.some((row) => row.name === 'approval_dispatch_prompt_template');
    const hasDirectChat = columns.some((row) => row.name === 'direct_chat_json');
    if (!hasChatTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN chat_prompt_template TEXT');
    }
    if (!hasTaskTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN task_prompt_template TEXT');
    }
    if (!hasFlowDispatchTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN flow_dispatch_prompt_template TEXT');
    }
    if (!hasTaskReviewTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN task_review_prompt_template TEXT');
    }
    if (!hasApprovalDispatchTemplate) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN approval_dispatch_prompt_template TEXT');
    }
    if (!hasDirectChat) {
      this.db.exec('ALTER TABLE agent_definitions ADD COLUMN direct_chat_json TEXT');
    }
  }
}

export const agentDefinitionStore = new AgentDefinitionStore();
export { AgentDefinitionStore };
