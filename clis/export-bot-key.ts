#!/usr/bin/env bun

/**
 * Export bot key CLI
 *
 * Retrieves the bot key nsec for the current session and outputs it
 * in a format suitable for setting AGENT_NSEC in the environment.
 *
 * Usage:
 *   bun clis/export-bot-key.ts [options]
 *
 * When run inside an agent session (SESSION_ID set), exports the bot
 * key nsec via the Wingman API. Output formats:
 *   --env       Print as AGENT_NSEC=<hex> (default, for eval/export)
 *   --hex       Print raw 64-char hex nsec
 *   --nsec      Print bech32 nsec1… string
 *   --json      Print full JSON response
 */

import { parseCommonFlags, resolveBaseUrl, requestJsonBotCrypto } from "./lib/auth";

const USAGE = `Export bot key CLI — retrieve AGENT_NSEC for the current session

Usage:
  bun clis/export-bot-key.ts [options]

Output formats:
  --env          Print as AGENT_NSEC=<hex> (default)
  --hex          Print raw 64-char hex nsec
  --nsec         Print bech32 nsec1… string
  --json         Print full JSON response

Options:
  --url <url>    Wingman URL (env: WINGMAN_URL)
  --session <id> Session ID (env: SESSION_ID)
  -h, --help     Show help

Examples:
  # Inside an agent session (SESSION_ID set automatically):
  eval $(bun clis/export-bot-key.ts --env)

  # Explicit session:
  bun clis/export-bot-key.ts --session abc123 --hex

  # Full JSON output:
  bun clis/export-bot-key.ts --json`;

interface ExportResponse {
  nsec: string;
  nsecHex: string;
  botPubkeyHex: string;
  botNpub: string;
  source: string;
}

type OutputFormat = "env" | "hex" | "nsec" | "json";

async function run() {
  const { args, urlInput, asJson, help } = parseCommonFlags(Bun.argv.slice(2));

  let sessionId: string | undefined;
  let format: OutputFormat = "env";

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--session") {
      sessionId = args[++i];
      if (!sessionId) throw new Error("--session requires a value");
    } else if (flag === "--env") {
      format = "env";
    } else if (flag === "--hex") {
      format = "hex";
    } else if (flag === "--nsec") {
      format = "nsec";
    }
  }

  if (asJson) format = "json";

  if (help) {
    console.log(USAGE);
    return;
  }

  // Resolve session ID from flag or environment
  sessionId = sessionId ?? Bun.env.SESSION_ID;
  if (!sessionId) {
    throw new Error(
      "No session ID found. Set SESSION_ID env var or pass --session <id>.",
    );
  }

  const baseUrl = resolveBaseUrl(urlInput);

  const result = await requestJsonBotCrypto<ExportResponse>(
    baseUrl,
    "POST",
    "/api/bot-keys/export-nsec",
    { sessionId },
  );

  switch (format) {
    case "env":
      console.log(`AGENT_NSEC=${result.nsecHex}`);
      break;
    case "hex":
      console.log(result.nsecHex);
      break;
    case "nsec":
      console.log(result.nsec);
      break;
    case "json":
      console.log(JSON.stringify(result, null, 2));
      break;
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
