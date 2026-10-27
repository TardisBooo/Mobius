const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadReceipt, checkPageUrl } = require('./verify-lineage-webview.cjs');

test('candidate and installed checks reject a development frontend', () => {
  for (const layer of ['candidate', 'installed']) {
    assert.throws(() => checkPageUrl('http://localhost:1420/', layer), /development server/);
  }
  assert.doesNotThrow(() => checkPageUrl('http://localhost:1420/', 'source'));
  assert.doesNotThrow(() => checkPageUrl('http://tauri.localhost/', 'installed'));
  assert.throws(() => checkPageUrl('about:blank', 'candidate'), /has not loaded/);
  assert.throws(() => checkPageUrl('https://unrelated.example/', 'installed'), /packaged application assets/);
});

test('a receipt is invalid when the binary or isolated profile changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-identity-'));
  const executable = path.join(root, 'candidate.exe');
  fs.writeFileSync(executable, 'first build');
  const receipt = { Fixture: root, Profile: path.join(root, 'webview'), Layer: 'candidate',
    ProcessId: 1234, Port: 9337, Executable: executable,
    BinarySha256: crypto.createHash('sha256').update('first build').digest('hex') };
  const save = () => fs.writeFileSync(path.join(root, 'launch-receipt.json'), JSON.stringify(receipt));
  save();
  assert.equal(loadReceipt(root).BinarySha256, receipt.BinarySha256);
  receipt.Profile = path.join(root, 'another-profile');
  save();
  assert.throws(() => loadReceipt(root), /Wrong WebView profile/);
  receipt.Profile = path.join(root, 'webview');
  save();
  fs.writeFileSync(executable, 'second build');
  assert.throws(() => loadReceipt(root), /binary changed/);
});
