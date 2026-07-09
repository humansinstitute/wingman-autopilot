import { hostname } from "node:os";

export interface RemoteInstructVariables {
  [key: string]: string;
}

export interface RenderRemoteInstructResult {
  content: string;
  variables: RemoteInstructVariables;
  missingVariables: string[];
}

export interface LoadRemoteInstructOptions {
  promptPath: string;
  variables: RemoteInstructVariables;
}

export class RemoteInstructConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteInstructConfigError";
  }
}

const VARIABLE_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

export function buildRemoteInstructVariables(input: {
  autopilotUrl: string;
  defaultWorkdir: string;
  agentTypes: string[];
  viewerNpub: string | null;
  authMethod: string | null;
  projectReference?: string | null;
}): RemoteInstructVariables {
  const sortedAgentTypes = [...input.agentTypes].sort((a, b) => a.localeCompare(b));
  return {
    hostname: hostname(),
    autopilot_url: input.autopilotUrl,
    project_reference: input.projectReference?.trim() || "autopilot",
    default_workdir: input.defaultWorkdir,
    agent_types: sortedAgentTypes.join(", "),
    viewer_npub: input.viewerNpub ?? "",
    auth_method: input.authMethod ?? "",
  };
}

export function renderRemoteInstructTemplate(
  template: string,
  variables: RemoteInstructVariables,
): RenderRemoteInstructResult {
  const missingVariables = new Set<string>();
  const content = template.replace(VARIABLE_PATTERN, (match, key: string) => {
    if (Object.hasOwn(variables, key)) {
      return variables[key] ?? "";
    }
    missingVariables.add(key);
    return match;
  });

  return {
    content,
    variables,
    missingVariables: Array.from(missingVariables).sort(),
  };
}

export async function loadRemoteInstruct(
  options: LoadRemoteInstructOptions,
): Promise<RenderRemoteInstructResult> {
  const file = Bun.file(options.promptPath);
  if (!(await file.exists())) {
    throw new RemoteInstructConfigError(
      `Remote Instruct prompt is not configured at ${options.promptPath}`,
    );
  }

  const template = await file.text();
  return renderRemoteInstructTemplate(template, options.variables);
}
