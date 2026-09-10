import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Windows lets HTML5 workspace drops reach the frontend', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  // CDP dragTo bypasses the OS drag handler and cannot detect this regression.
  // Tauri's default (true) intercepts WebView2 HTML5 drag/drop on Windows.
  for (const window of config.app.windows) {
    assert.equal(window.dragDropEnabled, false,
      'Frontend HTML5 drop zones require dragDropEnabled: false; verify with a native mouse too');
  }
});
