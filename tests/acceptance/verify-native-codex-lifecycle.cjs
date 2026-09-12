// Installed, unmodified Codex via its official app-server protocol.
// Optional explicit live test uses existing native authentication without copying it.
// No real-session copies or config-file edits.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const assert = require('node:assert/strict');

function client(executable, root, live) {
  const child = spawn(executable, ['-c', 'check_for_update_on_startup=false', '--disable', 'recommended_plugins', 'app-server'], {
    cwd: path.join(root, 'workspace'), windowsHide: true,
    env: live ? { ...process.env } : { ...process.env, CODEX_HOME: path.join(root, 'codex-home') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map(); const completions = new Map(); let sequence = 0;
  child.stderr.resume(); // Native diagnostics can contain machine paths; do not publish them.
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (value.method === 'turn/completed') completions.set(value.params.turn.id, value.params.turn);
    if (value.method === 'item/commandExecution/requestApproval' || value.method === 'item/fileChange/requestApproval') {
      child.stdin.write(JSON.stringify({ id:value.id, result:{ decision:'decline' } }) + '\n');
    }
    const item = waiting.get(value.id);
    if (item) { waiting.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error(JSON.stringify(value.error))) : item.resolve(value.result); }
  });
  const rejectAll = error => { for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(error); } waiting.clear(); };
  child.on('error', rejectAll);
  child.on('exit', code => rejectAll(Error(`Native server exited: ${code}`)));
  return {
    async rpc(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(Error(`${method} timed out`)); }, 45000);
        waiting.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ method, params: {} }) + '\n'); },
    async completed(id) {
      const deadline = Date.now() + 120000;
      while (!completions.has(id)) {
        if (Date.now() > deadline || child.exitCode !== null) throw Error('Native test turn did not complete');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return completions.get(id);
    },
    async close() {
      if (child.exitCode !== null) return;
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
      lines.close();
    },
  };
}

(async () => {
  const root = path.resolve(process.argv[2] || '');
  const executable = path.resolve(process.argv[3] || '');
  const live = process.argv[4] === '--submit-test-turn';
  assert(live, 'A persisted lifecycle check requires the explicit --submit-test-turn flag; empty native threads have no rollout');
  assert(root.startsWith('E:\\Workspaces\\_verification\\mobius-'));
  assert(!fs.existsSync(root), 'Use a new isolated fixture; never overwrite');
  assert(executable.endsWith('codex.exe') && fs.statSync(executable).isFile());
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(root, 'codex-home'));
  fs.writeFileSync(path.join(root, 'README.md'), `Möbius native Codex lifecycle verification. Retained for review; not an accepted release. Installed executable, isolated project. Live fixed-response test turn: ${live}. Authentication is never copied.\n`);
  let server = client(executable, root, live);
  const initialize = async () => {
    await server.rpc('initialize', { clientInfo: { name: 'mobius_lifecycle_acceptance', version: '1.0' }, capabilities: { experimentalApi: true } });
    server.notify('initialized');
  };
  try {
    await initialize();
    const started = await server.rpc('thread/start', { cwd: path.join(root, 'workspace'), approvalPolicy: 'never', sandbox: 'read-only' });
    const id = started.thread.id;
    assert(id);
    if (live) {
      const response = await server.rpc('turn/start', { threadId:id, input:[{type:'text',text:'For this isolated Mobius acceptance check, reply exactly MOBIUS_NATIVE_LIFECYCLE_OK. Do not use tools, read files, execute commands, or edit anything.',text_elements:[]}] });
      const completed = await server.completed(response.turn.id);
      assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
    }
    const read = await server.rpc('thread/read', { threadId: id, includeTurns: false });
    assert.equal(read.thread.id, id);
    await server.close();
    server = client(executable, root, live);
    await initialize();
    const resumed = await server.rpc('thread/resume', { threadId: id, cwd: path.join(root, 'workspace'), excludeTurns: true });
    assert.equal(resumed.thread.id, id);
    const report = { passed: true, layer: 'official native app-server', startedAndRead: true, resumedAfterProcessRestart: true, modelTurnSubmitted: live, verifiesCrossHarnessHandoff: false };
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await server.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
