/**
 * 3-Word Alias Generator for Gitea Repo Names
 *
 * Generates memorable, unique-ish aliases like "quick-jumps-fox"
 * for use as Gitea repository names when the user doesn't provide one.
 */

// ---------------------------------------------------------------------------
// Word lists (~16 each)
// ---------------------------------------------------------------------------

const ADJECTIVES = [
  "bold", "calm", "dark", "fast", "keen", "loud", "mild", "neat",
  "pure", "rare", "slim", "soft", "tall", "warm", "wide", "wise",
];

const VERBS = [
  "binds", "calls", "darts", "finds", "grabs", "holds", "jumps", "keeps",
  "leads", "marks", "opens", "pulls", "reads", "sends", "takes", "wraps",
];

const NOUNS = [
  "arch", "bolt", "cube", "disk", "edge", "flux", "gate", "hive",
  "iron", "jade", "knot", "lens", "mesh", "node", "orb", "pine",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Sanitize a string to kebab-case suitable for a git repo name.
 * Strips non-alphanumeric characters (except hyphens), collapses runs,
 * trims leading/trailing hyphens, and lowercases.
 */
function toKebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a 3-word alias like "bold-jumps-arch".
 */
export function generate3WordAlias(): string {
  return `${pick(ADJECTIVES)}-${pick(VERBS)}-${pick(NOUNS)}`;
}

/**
 * Generate a repo name, optionally incorporating a project name.
 *
 * - No project name: "bold-jumps-arch"
 * - With project name: "bold-jumps-arch-my-project"
 */
export function generateRepoName(projectName?: string): string {
  const alias = generate3WordAlias();
  if (!projectName || projectName.trim().length === 0) {
    return alias;
  }
  const sanitized = toKebab(projectName.trim());
  return sanitized ? `${alias}-${sanitized}` : alias;
}
