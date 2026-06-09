import { describe, expect, test } from 'bun:test';

import {
  getLiveDrawerLayoutState,
  getRenderedLiveDrawerVisible,
} from './drawer-visibility.js';

describe('drawer-visibility', () => {
  test('treats writer, app, artifact, and webview splits as drawer-suppressing layouts', () => {
    expect(getLiveDrawerLayoutState({
      effectiveFile: '/tmp/file.txt',
      writerLayout: { open: true },
    }).splitPanelOpen).toBe(true);

    expect(getLiveDrawerLayoutState({
      writerLayout: { open: true },
    }).splitPanelOpen).toBe(true);

    expect(getLiveDrawerLayoutState({
      artifactsLayout: { open: true },
    }).splitPanelOpen).toBe(true);

    expect(getLiveDrawerLayoutState({
      matchingApp: { id: 'app-1' },
      appCardLayout: { open: true },
    }).splitPanelOpen).toBe(true);

    expect(getLiveDrawerLayoutState({
      webApp: { id: 'web-1' },
      webviewLayout: { open: true },
    }).splitPanelOpen).toBe(true);
  });

  test('reports the drawer as hidden while a split panel is occupying the live layout', () => {
    expect(getRenderedLiveDrawerVisible({
      drawerState: { open: false, userToggled: false },
      viewportWidth: 1280,
      layoutState: { splitPanelOpen: true },
    })).toBe(false);
  });

  test('keeps the drawer hidden by default when no split panel is open', () => {
    expect(getRenderedLiveDrawerVisible({
      drawerState: { open: false, userToggled: false },
      viewportWidth: 1280,
      layoutState: { splitPanelOpen: false },
    })).toBe(false);
  });
});
