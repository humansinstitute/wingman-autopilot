/**
 * MCP Tool: ngit_init
 *
 * Convenience tool that initializes a git repository on Nostr in one call.
 * Publishes both the repository announcement (kind 30617) and the initial
 * branch state (kind 30618). Equivalent to ngit_publish_repo + ngit_push_state.
 *
 * Requires an active grant for domain "nostr.git" — call request_api_access first.
 */

import { z } from "zod";

export const ngitInitSchema = {
  identifier: z
    .string()
    .describe("Repository identifier (kebab-case, e.g. 'my-project'). Must be unique per user."),
  name: z
    .string()
    .optional()
    .describe("Human-readable project name"),
  description: z
    .string()
    .optional()
    .describe("Short description of the repository"),
  clone_urls: z
    .array(z.string())
    .optional()
    .describe("Git clone URLs (https, ssh). If omitted and Gitea is configured, a repo is auto-created on Gitea."),
  web_urls: z
    .array(z.string())
    .optional()
    .describe("Web URLs for browsing the repository"),
  refs: z
    .record(z.string(), z.string())
    .describe("Branch/tag name → commit SHA mapping. E.g. { 'refs/heads/main': 'abc123...' }"),
  head: z
    .string()
    .optional()
    .describe("Default branch name (e.g. 'main')"),
  relays: z
    .array(z.string())
    .optional()
    .describe("Nostr relay URLs. Defaults to Wingman's configured relays."),
  maintainers: z
    .array(z.string())
    .optional()
    .describe("Additional maintainer pubkeys (hex)"),
  hashtags: z
    .array(z.string())
    .optional()
    .describe("Topics/hashtags for discoverability"),
  earliest_unique_commit: z
    .string()
    .optional()
    .describe("SHA of the earliest unique commit — used to identify the repo among forks"),
  create_remote: z
    .boolean()
    .optional()
    .describe("Whether to auto-create a Gitea repo (default true). Set false to skip Gitea provisioning."),
};

export const ngitInitDescription =
  "Initialize a git repository on Nostr (NIP-34) in a single call. " +
  "Publishes both the repository announcement (kind 30617) and the initial " +
  "branch/tag state (kind 30618). This makes the repository discoverable on " +
  "gitworkshop.dev and other NIP-34 clients.\n\n" +
  "If Gitea is configured on the server, this tool also auto-creates a git " +
  "repository on the Gitea instance (unless clone_urls are provided or " +
  "create_remote=false). The Gitea clone URL is then included in the Nostr " +
  "announcement so gitworkshop.dev users can clone via the Gitea server.\n\n" +
  "The event is signed with the logged-in user's Nostr identity.\n\n" +
  "IMPORTANT: You must first call request_api_access with domain='nostr.git' to get a signing grant. " +
  "The user must have an active browser session for Tier 2 signing.\n\n" +
  "Typical usage:\n" +
  "1. Read git repo info: `git remote -v`, `git rev-parse HEAD`, `git branch -a`\n" +
  "2. Call request_api_access(domain='nostr.git', reason='Initialize repo on Nostr')\n" +
  "3. Call ngit_init with the repo metadata and branch refs\n" +
  "4. If Gitea repo was created, add the remote and push: " +
  "`git remote add origin <clone_url> && git push -u origin main`";

interface NgitInitParams {
  identifier: string;
  name?: string;
  description?: string;
  clone_urls?: string[];
  web_urls?: string[];
  refs: Record<string, string>;
  head?: string;
  relays?: string[];
  maintainers?: string[];
  hashtags?: string[];
  earliest_unique_commit?: string;
  create_remote?: boolean;
}

interface GiteaResultInfo {
  cloneUrl: string;
  sshUrl: string;
  htmlUrl: string;
  created: boolean;
}

function formatGiteaResult(gitea: GiteaResultInfo | null | undefined): string[] {
  if (!gitea) return [];
  return [
    "",
    `Gitea: ${gitea.created ? "created" : "found existing"} repository`,
    `  Clone URL: ${gitea.cloneUrl}`,
    `  SSH URL:   ${gitea.sshUrl}`,
    `  Web URL:   ${gitea.htmlUrl}`,
    "",
    "Next steps:",
    `  git remote add origin ${gitea.cloneUrl}`,
    `  git push -u origin main`,
  ];
}

export async function handleNgitInit(
  params: NgitInitParams,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const response = await fetch(`${wingmanUrl}/api/ngit/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...params }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: `Failed to initialize repository (${response.status}): ${error}`,
        }],
      };
    }

    const result = await response.json();

    // Build Gitea section if present
    const giteaLines = formatGiteaResult(result.gitea);

    // Handle partial success (announcement OK, state failed)
    if (result.partial) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `Repository "${params.name ?? params.identifier}" partially initialized`,
            ...giteaLines,
            "",
            `Announcement: published (event ${result.announcement.eventId})`,
            `  Relays: ${result.announcement.successes} succeeded, ${result.announcement.failures} failed`,
            "",
            `State: FAILED — ${result.state.error}`,
            "",
            "You can retry the state push with ngit_push_state.",
          ].join("\n"),
        }],
      };
    }

    const announcementRelays = result.announcement.relays
      ?.map((r: { relay: string; ok: boolean; error?: string }) =>
        `  ${r.ok ? "+" : "-"} ${r.relay}${r.error ? ` (${r.error})` : ""}`,
      )
      .join("\n") ?? "";

    const stateRelays = result.state.relays
      ?.map((r: { relay: string; ok: boolean; error?: string }) =>
        `  ${r.ok ? "+" : "-"} ${r.relay}${r.error ? ` (${r.error})` : ""}`,
      )
      .join("\n") ?? "";

    return {
      content: [{
        type: "text" as const,
        text: [
          `Repository "${params.name ?? params.identifier}" initialized on Nostr`,
          ...giteaLines,
          "",
          `Announcement (kind 30617):`,
          `  Event ID: ${result.announcement.eventId}`,
          `  Relays: ${result.announcement.successes} succeeded, ${result.announcement.failures} failed`,
          announcementRelays,
          "",
          `State (kind 30618):`,
          `  Event ID: ${result.state.eventId}`,
          `  Refs: ${result.state.refsCount} branches/tags`,
          `  Relays: ${result.state.successes} succeeded, ${result.state.failures} failed`,
          stateRelays,
        ].join("\n"),
      }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: `Failed to reach Wingman server: ${(err as Error).message}`,
      }],
    };
  }
}
