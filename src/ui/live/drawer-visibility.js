import { isLiveDrawerVisible } from './session-drawer.js';

export function getLiveDrawerLayoutState({
  effectiveFile = null,
  matchingApp = null,
  webApp = null,
  writerLayout = {},
  artifactsLayout = {},
  appCardLayout = {},
  webviewLayout = {},
} = {}) {
  const writerVisible = Boolean(writerLayout?.open);
  const artifactsVisible = Boolean(artifactsLayout?.open);
  const appCardVisible = Boolean(matchingApp) && Boolean(appCardLayout?.open);
  const webviewVisible = Boolean(webApp) && Boolean(webviewLayout?.open);

  return {
    writerVisible,
    artifactsVisible,
    appCardVisible,
    webviewVisible,
    splitPanelOpen: writerVisible || artifactsVisible || appCardVisible || webviewVisible,
  };
}

export function getRenderedLiveDrawerVisible({
  drawerState,
  viewportWidth = 1024,
  layoutState,
} = {}) {
  if (layoutState?.splitPanelOpen) {
    return false;
  }
  return isLiveDrawerVisible(drawerState, viewportWidth);
}
