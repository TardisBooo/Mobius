"""Read-only audit of catalogue identities; emits counts, never conversations."""
import argparse
import json
from pathlib import Path
import sqlite3

p = argparse.ArgumentParser()
p.add_argument('--database', type=Path, required=True)
p.add_argument('--baseline', type=Path)
args = p.parse_args()
c = sqlite3.connect(args.database.resolve().as_uri()+'?mode=ro', uri=True)
rows = c.execute("select id,provider_session_id,source_path,source_available,capabilities_json from sessions where provider='codex'").fetchall()
counts = dict(rows=len(rows), available=0, missing=0, wrong_identity=0, child_resumable=0, stale_resumable=0)
for row_id, native, source, available, capabilities in rows:
    caps = json.loads(capabilities)
    if not available:
        counts['missing'] += 1
        counts['stale_resumable'] += 'native_resume' in caps
        continue
    counts['available'] += 1
    with Path(source).open(encoding='utf-8') as f:
        header = json.loads(f.readline())['payload']
    counts['wrong_identity'] += native != header.get('id', header.get('session_id'))
    child = isinstance(header.get('source'), dict) and 'subagent' in header['source']
    counts['child_resumable'] += child and 'native_resume' in caps
if args.baseline:
    b = sqlite3.connect(args.baseline.resolve().as_uri()+'?mode=ro', uri=True)
    old = {r[0] for r in b.execute('select id from sessions')}
    now = {r[0] for r in c.execute('select id from sessions')}
    counts['lost_row_ids'] = len(old-now)
    old_edges = set(b.execute('select id,source_session_id,target_session_id from relay_edges'))
    new_edges = set(c.execute('select id,source_session_id,target_session_id from relay_edges'))
    counts['lost_or_changed_relay_edges'] = len(old_edges-new_edges)
print(json.dumps(counts))
assert all(counts.get(k, 0) == 0 for k in ['wrong_identity', 'child_resumable', 'stale_resumable', 'lost_row_ids', 'lost_or_changed_relay_edges']), counts
