const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadReceipt, checkPageUrl, verifyOwnedProcess } = require('./verify-lineage-webview.cjs');

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
    ProcessId: 1234, StartedAt: '2000-01-01T00:00:00.0000000Z', Port: 9337, Executable: executable,
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

test('a stale start identity cannot stop a live process with the expected executable and port', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', `
    let port = 9380;
    function listen() {
      const server = require('node:net').createServer();
      server.once('error', error => { if (error.code === 'EADDRINUSE' && port < 9399) { port++; listen(); } else process.exit(1); });
      server.listen(port, '127.0.0.1', () => console.log(port));
    }
    listen();
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', data => resolve(Number(String(data).trim())));
    child.once('error', reject);
    child.once('exit', code => reject(Error(`Fixture exited before listening: ${code}`)));
  });
  assert.throws(() => verifyOwnedProcess({ ProcessId: child.pid, Executable: process.execPath,
    Port: port, StartedAt: '2000-01-01T00:00:00.0000000Z' }, 'stop'), /Launch process identity changed/);
  assert.equal(child.exitCode, null);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});