// Real packaged Tauri IPC + real PowerShell; a recording shim replaces the
// model CLI here. The native Codex API is covered in tests/codex_native_resume.py.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.env.MOBIUS_RESUME_TEST_ROOT;
assert(root && root.includes('_verification'), 'Require an isolated verification profile');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9367');
const page = browser.contexts().flatMap(c => c.pages()).find(p => /tauri/.test(p.url()));
assert(page, 'Packaged Tauri page required');
const invoke = (command, args = {}) => page.evaluate(({command, args}) => window.__TAURI_INTERNALS__.invoke(command, args), {command, args});
try {
  const health = await invoke('health');
  assert(health.database_path.toLowerCase().startsWith(root.toLowerCase()), 'Do not test a shared user profile');
  await invoke('refresh_sessions');
  const hits = await invoke('query_sessions', {query: {query: '', providers: [], workspace_id: null, checkout_id: null, limit: 100}});
  const parent = hits.find(h => h.session.provider_session_id === '11111111-1111-4111-8111-111111111111').session;
  const child = hits.find(h => h.session.provider_session_id === '22222222-2222-4222-8222-222222222222').session;
  assert(parent.capabilities.includes('native_resume'));
  assert(!child.capabilities.includes('native_resume'));
  await assert.rejects(invoke('resume_session', {sessionId: child.id}));
  assert.equal((await invoke('terminal_list')).length, 0, 'Rejected child must not create a PTY');
  const terminal = await invoke('resume_session', {sessionId: parent.id});
  let data = '';
  for (let tries = 0; tries < 30; tries++) {
    data = (await invoke('terminal_snapshot', {id: terminal.id})).data;
    if (data.includes('"args"')) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const clean = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const recordLine = clean.split(/\r?\n/).find(line => line.trim().startsWith('{') && line.includes('"args"'));
  assert(recordLine, 'Recording CLI must actually run, not just echo its launch command');
  const recorded = JSON.parse(recordLine.trim());
  assert.equal(recorded.args.at(-1), parent.provider_session_id, 'Exact native ID must reach the CLI');
  const cdIndex = recorded.args.indexOf('-C');
  assert.notEqual(cdIndex, -1, 'Official Codex working-root option must be explicit');
  assert.equal(path.resolve(recorded.args[cdIndex + 1]), path.join(root, 'workspace'), 'Official Codex must receive the ordinary project path');
  assert.equal(path.resolve(recorded.home), path.join(root, 'native-home'), 'Source-owned home must reach the CLI');
  await invoke('terminal_close', {id: terminal.id});
  const source = path.join(root, 'native-home/sessions/2026/09/11/parent.jsonl');
  const original = await fs.readFile(source, 'utf8');
  const replaced = original.replaceAll(parent.provider_session_id, '33333333-3333-4333-8333-333333333333');
  await fs.writeFile(source, replaced); // synthetic test-owned file only
  try { await assert.rejects(invoke('resume_session', {sessionId: parent.id}), /identity/); }
  finally { await fs.writeFile(source, original); }
  await fs.writeFile(source, '{broken\n' + original);
  try { await assert.rejects(invoke('resume_session', {sessionId: parent.id}), /malformed/); }
  finally { await fs.writeFile(source, original); }
  const moved = source + '.test-moved';
  await fs.rename(source, moved);
  try { await assert.rejects(invoke('resume_session', {sessionId: parent.id}), /moved|disappeared/); }
  finally { await fs.rename(moved, source); }
  assert.equal((await invoke('terminal_list')).length, 0);
  console.log(JSON.stringify({packaged_ipc: 'PASS', powershell_exact_id_and_home: 'PASS', child_rejected: 'PASS', changed_source_rejected: 'PASS', corrupt_header_rejected: 'PASS', missing_source_rejected: 'PASS', cli_driver: 'recording shim; native Codex tested separately'}));
} finally {
  await browser.close();
}
