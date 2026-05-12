const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const rootDir = __dirname;
const logDir = join(rootDir, 'data', 'logs');

function parseEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .reduce((env, rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        return env;
      }

      const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
      const equalsIndex = normalized.indexOf('=');
      if (equalsIndex < 1) {
        return env;
      }

      const key = normalized.slice(0, equalsIndex).trim();
      let value = normalized.slice(equalsIndex + 1).trim();
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
      env[key] = value;
      return env;
    }, {});
}

mkdirSync(logDir, { recursive: true });

const localEnv = parseEnvFile(join(rootDir, '.env'));
const bunBin = process.env.BUN_BIN || localEnv.BUN_BIN || '/Users/mini/.bun/bin/bun';
const agentSpawnMode = process.env.AGENT_SPAWN_MODE || 'tmux';
const agentTmuxSession = process.env.AGENT_TMUX_SESSION || 'wm-ap-agents';

module.exports = {
  apps: [
    {
      name: 'wm-ap',
      cwd: rootDir,
      script: bunBin,
      args: 'run src/index.ts',
      interpreter: 'none',
      env: {
        ...localEnv,
        NODE_ENV: localEnv.NODE_ENV || 'development',
        AGENT_SPAWN_MODE: agentSpawnMode,
        AGENT_TMUX_SESSION: agentTmuxSession,
        AGENTAPI_BIN: localEnv.AGENTAPI_BIN || join(rootDir, 'out', 'agentapi'),
        CODEX_CLI: localEnv.CODEX_CLI || '/Users/mini/.bun/bin/codex',
      },
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 1000,
      kill_signal: 'SIGINT',
      kill_timeout: 10000,
      out_file: join(logDir, 'pm2-wingman-out.log'),
      error_file: join(logDir, 'pm2-wingman-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
