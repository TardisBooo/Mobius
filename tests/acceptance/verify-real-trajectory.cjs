// Audits native logs produced by the real UI test, never fixture data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const vault = 'D:/DataVault/Mobius-Verification-20260908-final/handoff-trajectories';
const evidence = 'D:/AcceptedArtifacts/Mobius-Verification-20260908-final';
const pi = 'E:/Workspaces/Mobius-Verification-20260908-final/harness-home/.pi/agent/sessions/2026-09-08T14-20-56-556Z_01a08164-b76c-7695-9658-b1c4bd471f4c.jsonl';
const events = fs.readFileSync(pi, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const snapshots = fs.readdirSync(vault).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(vault, name), 'utf8')));
const snapshot = snapshots.find(s => s.sources.length === 2 && fs.existsSync(path.join(vault, `${s.id}-source-1.jsonl`)));
assert(snapshot, 'No actual two-source handoff found');
const results = [];
for (let i = 0; i < snapshot.sources.length; i++) {
  const source = snapshot.sources[i];
  const raw = fs.readFileSync(path.join(vault, `${snapshot.id}-source-${i + 1}.jsonl`), 'utf8');
  assert.equal(raw, source.content);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), source.sha256);
  const call = events.flatMap(e => e.message?.content || []).find(c => c.type === 'toolCall' && c.name === 'read' && c.arguments.path.replaceAll('\\', '/').endsWith(`${snapshot.id}-source-${i + 1}.jsonl`));
  assert(call, 'Target did not request the original source');
  const response = events.find(e => e.message?.role === 'toolResult' && e.message.toolCallId === call.id)?.message;
  assert(response && !response.isError, 'Source read failed');
  const returned = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.equal(returned.trimEnd(), raw.trimEnd(), 'Tool returned a truncated or altered source');
  results.push({provider: source.provider, nativeId: source.native_id, bytes: Buffer.byteLength(raw), sha256: source.sha256, toolCallId: call.id, exactRead: true});
}
const original = snapshot.sources[0].content.trim().split(/\r?\n/).map(JSON.parse);
assert(original.some(e => e.message?.role === 'toolResult' && e.message.isError), 'Missing original failed tool result');
assert(original.some(e => e.message?.content?.some(c => c.type === 'toolCall' && c.name === 'write')), 'Missing original write call');
const report = {snapshotId: snapshot.id, targetNativeId: '01a08164-b76c-7695-9658-b1c4bd471f4c', sources: results, pass: true};
fs.writeFileSync(path.join(evidence, 'real-trajectory-integrity.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
