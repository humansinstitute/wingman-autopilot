import { pathToFileURL } from 'node:url';

import type { YokeBotHelpersModule } from './types';

let cachedModule: Promise<YokeBotHelpersModule> | null = null;

function resolveYokeBotHelpersUrl(): string {
  const override = Bun.env.AGENT_CHAT_YOKE_HELPERS_PATH?.trim();
  if (override) {
    return pathToFileURL(override).href;
  }
  return new URL('../../../wingmanbefree/wingman-yoke/src/bot-helpers.js', import.meta.url).href;
}

export async function loadYokeBotHelpers(): Promise<YokeBotHelpersModule> {
  if (!cachedModule) {
    cachedModule = import(resolveYokeBotHelpersUrl()).then((module) => {
      const required = [
        'createBotWorkspaceKey',
        'loadBotWorkspaceKey',
        'signBotRequest',
        'signWorkspaceRequest',
        'fetchBotGroupKeys',
        'loadBotGroupKeys',
        'decryptChatRecord',
        'normalizeThreadId',
        'normalizeChannelParticipants',
        'normalizeChatRoutingContext',
      ] as const;
      for (const key of required) {
        if (typeof module[key] !== 'function') {
          throw new Error(`Yoke bot helper export missing: ${key}`);
        }
      }
      return module as unknown as YokeBotHelpersModule;
    });
  }
  return cachedModule;
}
