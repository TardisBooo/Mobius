"""Build a synthetic isolated profile for packaged IPC/PowerShell acceptance.

The CLI shim only records arguments/home. Real Codex is tested separately by
codex_native_resume.py. Never use this profile as a model-execution benchmark.
"""
import argparse
import json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('root', type=Path)
args = p.parse_args()
root = args.root.resolve()
root.mkdir(parents=True, exist_ok=False)
home = root / 'native-home'
sources = home / 'sessions/2026/09/11'
sources.mkdir(parents=True)
(root / 'bin').mkdir()
(root / 'workspace').mkdir()
(root / 'empty-harness').mkdir()
parent_id = '11111111-1111-4111-8111-111111111111'
child_id = '22222222-2222-4222-8222-222222222222'
for name, native_id, source in [('parent', parent_id, 'cli'), ('child', child_id,
    {'subagent': {'thread_spawn': {'parent_thread_id': parent_id}}})]:
    header = {'id': native_id, 'session_id': parent_id,
              'cwd': str(root / 'workspace'), 'source': source}
    events = [{'type': 'session_meta', 'payload': header},
              {'role': 'user', 'content': f'MOBIUS_RESUME_ACCEPTANCE_{name.upper()}'}]
    (sources / f'{name}.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in events), encoding='utf-8')
(root / 'bin/codex.ps1').write_text(
    "@{ args=$args; home=$env:CODEX_HOME; cwd=(Get-Location).Path } | ConvertTo-Json -Compress | Write-Output\n",
    encoding='utf-8')
print(json.dumps({'root': str(root), 'parent': parent_id, 'child': child_id}))
