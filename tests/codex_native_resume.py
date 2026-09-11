"""Native Codex integration check using an isolated copy, never the original.

No model turn is submitted. This verifies native history hydration/identity,
not model output quality. Requires the installed Codex executable.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--codex', required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--sandbox', type=Path, required=True)
    parser.add_argument('--powershell', action='store_true',
                        help='Launch the installed CLI through external PowerShell')
    parser.add_argument('--test-provider', action='store_true', help='Exercise a provider switch with a non-networking test endpoint')
    args = parser.parse_args()
    original_bytes = args.source.read_bytes()
    original_hash = hashlib.sha256(original_bytes).hexdigest()
    with args.source.open(encoding='utf-8') as source:
        header = json.loads(source.readline())['payload']
    native_id = header['id']
    assert args.sandbox.resolve() not in args.source.resolve().parents
    args.sandbox.mkdir(parents=True, exist_ok=False)
    home = args.sandbox / 'codex-home'
    destination = home / 'sessions/2026/09/11' / args.source.name
    destination.parent.mkdir(parents=True)
    shutil.copyfile(args.source, destination)
    workspace = args.sandbox / 'workspace'
    workspace.mkdir()
    env = dict(os.environ, CODEX_HOME=str(home.resolve()))
    # Disable optional plugins/network discovery. No keys or config are copied.
    command = [args.codex, '-c', 'check_for_update_on_startup=false',
        '--disable', 'recommended_plugins']
    if args.test_provider:
        command += ['-c', 'model_provider="resume_test_provider"',
            '-c', 'model_providers.resume_test_provider.name="Resume test"',
            '-c', 'model_providers.resume_test_provider.base_url="http://127.0.0.1:9/v1"',
            '-c', 'model_providers.resume_test_provider.wire_api="responses"']
    command += ['-C', str(workspace.resolve()), 'app-server']
    if args.powershell:
        shell = shutil.which('powershell.exe')
        assert shell, 'External PowerShell is required'
        invocation = '& ' + ' '.join("'" + value.replace("'", "''") + "'" for value in command)
        command = [shell, '-NoLogo', '-NoProfile', '-Command', invocation]
    proc = subprocess.Popen(command, env=env,
        cwd=workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, encoding='utf-8')
    messages = queue.Queue()
    def consume():
        for line in proc.stdout:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError:
                pass
    threading.Thread(target=consume, daemon=True).start()
    counter = 0
    def rpc(method, params):
        nonlocal counter
        counter += 1
        proc.stdin.write(json.dumps({'id': counter, 'method': method, 'params': params})+'\n')
        proc.stdin.flush()
        while True:
            result = messages.get(timeout=50)
            if result.get('id') == counter:
                if 'error' in result:
                    raise RuntimeError(f'{method}: {result["error"]}')
                return result['result']
    try:
        rpc('initialize', {'clientInfo': {'name': 'mobius_resume_acceptance', 'version': '1.0'},
                           'capabilities': {'experimentalApi': True}})
        proc.stdin.write('{"method":"initialized","params":{}}\n')
        proc.stdin.flush()
        read = rpc('thread/read', {'threadId': native_id, 'includeTurns': False})
        assert read['thread']['id'] == native_id
        is_child = isinstance(header.get('source'), dict) and 'subagent' in header['source']
        if is_child:
            try:
                rpc('thread/resume', {'threadId': native_id, 'excludeTurns': True})
            except RuntimeError as error:
                assert 'resume the parent first' in str(error), str(error)
            else:
                raise AssertionError('Expected native Codex child-agent restriction')
        else:
            resume_params = {'threadId': native_id,
                'cwd': str(workspace.resolve()), 'excludeTurns': True}
            if args.test_provider:
                resume_params['modelProvider'] = 'resume_test_provider'
            resumed = rpc('thread/resume', resume_params)
            assert resumed['thread']['id'] == native_id, 'Native server resumed the wrong thread'
            assert Path(resumed['cwd']).resolve() == workspace.resolve()
            if args.test_provider:
                assert resumed['modelProvider'] == 'resume_test_provider', 'Do not silently switch runtime routing to the historical provider'
                # An explicit empty provider list asks the documented app-server
                # interface for all providers; cwd still scopes the list.
                listed = rpc('thread/list', {'cwd': header['cwd'],
                    'modelProviders': [], 'sourceKinds': ['cli'],
                    'archived': False, 'useStateDbOnly': True, 'limit': 100})
                assert any(thread['id'] == native_id for thread in listed['data']), 'Thread still hidden by verbatim cwd filter'
        # The user's live conversation may append concurrently. Verify every
        # original byte, allowing only an append by its existing writer.
        with args.source.open('rb') as original:
            assert hashlib.sha256(original.read(len(original_bytes))).hexdigest() == original_hash
        print(json.dumps({'native_read': 'PASS', 'native_resume_identity': 'CHILD_REJECTED' if is_child else 'PASS',
            'native_resume_cwd': 'NOT_APPLICABLE' if is_child else 'PASS', 'original_prefix_unchanged': 'PASS',
            'concurrent_append_bytes': args.source.stat().st_size - len(original_bytes),
            'fork_differs_from_parent': native_id != header.get('session_id', native_id),
            'provider_and_cwd_picker_after_resume': 'PASS' if args.test_provider and not is_child else 'NOT_RUN',
            'model_turn_submitted': False}))
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.terminate()
            proc.wait(timeout=15)


if __name__ == '__main__':
    main()
