import { afterEach, describe, expect, test } from "bun:test";

import { GitHubApiClient, GitHubApiError } from "./github-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHubApiClient", () => {
  test("creates a user repository with the authenticated owner", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({
        clone_url: "https://github.com/pete/example.git",
        html_url: "https://github.com/pete/example",
        private: true,
      }), { status: 201 });
    }) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    const repo = await client.createRepository({
      owner: "pete",
      name: "example",
      private: true,
      authenticatedLogin: "pete",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/user/repos");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "example",
      private: true,
      auto_init: false,
    });
    expect(repo.cloneUrl).toBe("https://github.com/pete/example.git");
    expect(repo.htmlUrl).toBe("https://github.com/pete/example");
  });

  test("creates an organization repository when owner differs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({
        clone_url: "https://github.com/humansinstitute/starter.git",
        html_url: "https://github.com/humansinstitute/starter",
        private: true,
      }), { status: 201 });
    }) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    await client.createRepository({
      owner: "humansinstitute",
      name: "starter",
      private: true,
      authenticatedLogin: "pete",
    });

    expect(calls[0]?.url).toBe("https://api.github.com/orgs/humansinstitute/repos");
  });

  test("applies main branch protection with PR review restrictions", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    await client.protectBranch({
      owner: "pete",
      repo: "example",
      branch: "main",
      actorLogin: "pete",
      mode: "main",
    });

    expect(body?.required_pull_request_reviews).toEqual({
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 1,
    });
    expect(body?.required_conversation_resolution).toBe(true);
    expect(body?.restrictions).toEqual({ users: ["pete"], teams: [], apps: [] });
    expect(body?.allow_force_pushes).toBe(false);
    expect(body?.allow_deletions).toBe(false);
  });

  test("throws GitHubApiError with GitHub validation details", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        message: "Validation Failed",
        errors: [{ resource: "Repository", field: "name", code: "already_exists" }],
      }), { status: 422 })) as typeof fetch;

    const client = new GitHubApiClient("ghp_secret");
    await expect(client.createRepository({
      owner: "pete",
      name: "example",
      private: true,
      authenticatedLogin: "pete",
    })).rejects.toThrow("Validation Failed: Repository name already_exists");
    await expect(client.createRepository({
      owner: "pete",
      name: "example",
      private: true,
      authenticatedLogin: "pete",
    })).rejects.toBeInstanceOf(GitHubApiError);
  });
});
