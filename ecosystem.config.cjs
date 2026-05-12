module.exports = {
  apps: [
    {
      name: 'wm-ap',
      cwd: '/Users/mini/code/wingmanbefree/autopilot',
      script: '/Users/mini/.bun/bin/bun',
      args: 'run src/index.ts',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 1000,
      kill_signal: 'SIGINT',
      kill_timeout: 10000,
      time: true,
    },
  ],
};
