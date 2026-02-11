/**
 * NIP-34 Event Template Builder
 *
 * Builds unsigned Nostr event templates for git-related events:
 *   - Kind 30617: Repository announcement (addressable)
 *   - Kind 30618: Repository state (branch refs, HEAD)
 *
 * Templates are unsigned — they get signed by the user's browser
 * via the existing Tier 2 delegation flow before relay publication.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/34.md
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPO_ANNOUNCEMENT_KIND = 30617;
export const REPO_STATE_KIND = 30618;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface RepoAnnouncementInput {
  /** Repository identifier (kebab-case, e.g. "my-project"). Used as the `d` tag. */
  identifier: string;
  /** Human-readable project name. */
  name?: string;
  /** Short description of the repository. */
  description?: string;
  /** Git clone URLs (https, ssh, git://). */
  cloneUrls?: string[];
  /** Web URLs for browsing the repository. */
  webUrls?: string[];
  /** Relay URLs that should monitor for patches and issues. */
  relays?: string[];
  /** Additional maintainer pubkeys (hex). The signing user is always included. */
  maintainers?: string[];
  /** Hashtags / topics for discoverability. */
  hashtags?: string[];
  /** SHA of the earliest unique commit (for the `r` tag with `euc` marker). */
  earliestUniqueCommit?: string;
}

export interface RepoStateInput {
  /** Repository identifier — must match the `d` tag of the announcement. */
  identifier: string;
  /** Map of branch/tag names to commit SHAs. */
  refs: Record<string, string>;
  /** Default branch (e.g. "main"). Included as a HEAD tag. */
  head?: string;
  /** Relay URLs to publish to. */
  relays?: string[];
}

// ---------------------------------------------------------------------------
// Unsigned event template shape
// ---------------------------------------------------------------------------

export interface UnsignedEventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build an unsigned kind 30617 repository announcement event.
 */
export function buildRepoAnnouncement(input: RepoAnnouncementInput): UnsignedEventTemplate {
  const tags: string[][] = [
    ["d", input.identifier],
  ];

  if (input.name) {
    tags.push(["name", input.name]);
  }

  if (input.description) {
    tags.push(["description", input.description]);
  }

  if (input.cloneUrls) {
    for (const url of input.cloneUrls) {
      tags.push(["clone", url]);
    }
  }

  if (input.webUrls) {
    for (const url of input.webUrls) {
      tags.push(["web", url]);
    }
  }

  if (input.relays) {
    tags.push(["relays", ...input.relays]);
  }

  if (input.maintainers) {
    for (const pubkey of input.maintainers) {
      tags.push(["maintainers", pubkey]);
    }
  }

  if (input.earliestUniqueCommit) {
    tags.push(["r", input.earliestUniqueCommit, "euc"]);
  }

  if (input.hashtags) {
    for (const tag of input.hashtags) {
      tags.push(["t", tag.toLowerCase()]);
    }
  }

  return {
    kind: REPO_ANNOUNCEMENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.description ?? "",
  };
}

/**
 * Build an unsigned kind 30618 repository state event.
 */
export function buildRepoState(input: RepoStateInput): UnsignedEventTemplate {
  const tags: string[][] = [
    ["d", input.identifier],
  ];

  // Add refs — each branch/tag gets its own refs tag
  for (const [name, commitSha] of Object.entries(input.refs)) {
    tags.push(["refs", name, commitSha]);
  }

  if (input.head) {
    tags.push(["HEAD", `refs/heads/${input.head}`]);
  }

  if (input.relays) {
    tags.push(["relays", ...input.relays]);
  }

  return {
    kind: REPO_STATE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };
}
