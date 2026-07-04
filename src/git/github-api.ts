import { getGitHubUserCredentials, type GitHubUserCredentials } from "./github-credential-helper";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export type GitHubAuthenticatedUser = {
  login: string;
  id: number;
};

export type GitHubRepository = {
  owner: string;
  name: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
};

export type GitHubRepoProtectionMode = "main" | "deployed";

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

function normaliseGitHubOwner(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(trimmed)) {
    throw new Error("GitHub owner must be a valid user or organization name");
  }
  return trimmed;
}

function normaliseGitHubRepoName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error("GitHub repo name may only contain letters, numbers, dots, dashes, and underscores");
  }
  return trimmed;
}

async function parseGitHubJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

function resolveGitHubError(payload: Record<string, unknown>, fallback: string): string {
  const message = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : fallback;
  const errors = Array.isArray(payload.errors)
    ? payload.errors
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const record = entry as Record<string, unknown>;
          return [record.resource, record.field, record.code, record.message].filter(Boolean).join(" ");
        })
        .filter(Boolean)
    : [];
  return errors.length ? `${message}: ${errors.join("; ")}` : message;
}

export function getGitHubCredentialsForNpub(npub: string | null | undefined): GitHubUserCredentials | null {
  const normalized = typeof npub === "string" ? npub.trim() : "";
  return normalized ? getGitHubUserCredentials(normalized) : null;
}

export class GitHubApiClient {
  constructor(private readonly token: string) {}

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await parseGitHubJson(response);
    if (!response.ok) {
      throw new GitHubApiError(resolveGitHubError(payload, response.statusText), response.status);
    }
    return payload;
  }

  async getAuthenticatedUser(): Promise<GitHubAuthenticatedUser> {
    const payload = await this.request("GET", "/user");
    const login = typeof payload.login === "string" ? payload.login : "";
    const id = typeof payload.id === "number" ? payload.id : 0;
    if (!login) throw new Error("GitHub token did not return an authenticated user");
    return { login, id };
  }

  async createRepository(input: {
    owner: string;
    name: string;
    private: boolean;
    description?: string | null;
    authenticatedLogin: string;
  }): Promise<GitHubRepository> {
    const owner = normaliseGitHubOwner(input.owner);
    const name = normaliseGitHubRepoName(input.name);
    const body = {
      name,
      private: Boolean(input.private),
      auto_init: false,
      description: input.description || undefined,
    };
    const path =
      owner.toLowerCase() === input.authenticatedLogin.toLowerCase()
        ? "/user/repos"
        : `/orgs/${encodeURIComponent(owner)}/repos`;
    const payload = await this.request("POST", path, body);
    const cloneUrl = typeof payload.clone_url === "string" ? payload.clone_url : "";
    const htmlUrl = typeof payload.html_url === "string" ? payload.html_url : "";
    if (!cloneUrl || !htmlUrl) throw new Error("GitHub repository was created but did not return clone URLs");
    return {
      owner,
      name,
      cloneUrl,
      htmlUrl,
      private: Boolean(payload.private),
    };
  }

  async protectBranch(input: {
    owner: string;
    repo: string;
    branch: string;
    actorLogin: string;
    mode: GitHubRepoProtectionMode;
  }): Promise<void> {
    const requiredPullRequestReviews =
      input.mode === "main"
        ? {
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            required_approving_review_count: 1,
          }
        : null;

    await this.request(
      "PUT",
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches/${encodeURIComponent(input.branch)}/protection`,
      {
        required_status_checks: null,
        enforce_admins: true,
        required_pull_request_reviews: requiredPullRequestReviews,
        restrictions: {
          users: [input.actorLogin],
          teams: [],
          apps: [],
        },
        required_linear_history: true,
        allow_force_pushes: false,
        allow_deletions: false,
        block_creations: false,
        required_conversation_resolution: input.mode === "main",
        lock_branch: false,
        allow_fork_syncing: false,
      },
    );
  }
}
