"""Exercise the real Codex resume picker over ConPTY (no model prompt).

Use a new isolated home for the first run. This is a terminal protocol test,
not a desktop-click macro. Raw output is private local verification evidence.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import shutil
import sys
import time
import tomllib
import pyte
from winpty import PTY, WinptyError

p = argparse.ArgumentParser()
p.add_argument('--codex', required=True)
p.add_argument('--home', type=Path, required=True)
p.add_argument('--cwd', type=Path, required=True)
p.add_argument('--id', required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--source', type=Path, help='Verify that existing bytes of this original JSONL stay unchanged')
p.add_argument('--isolated', action='store_true')
p.add_argument('--slash', action='store_true', help='Open /resume from the actual interactive client')
p.add_argument('--powershell', action='store_true', help='Resolve --codex through a fresh external PowerShell')
p.add_argument('--select-id', action='store_true', help='Search the populated picker for --id before selecting')
p.add_argument('--expect-active-writer', action='store_true', help='Verify refusal to resume an already-running thread')
args = p.parse_args()

def prefix_digest(path, length):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        remaining = length
        while remaining:
            block = source.read(min(1024 * 1024, remaining))
            assert block, 'Historical source was truncated'
            digest.update(block)
            remaining -= len(block)
    return digest.hexdigest()

source_size = args.source.stat().st_size if args.source else 0
source_digest = prefix_digest(args.source, source_size) if args.source else None
command = [args.codex, '-c', 'check_for_update_on_startup=false',
           '--disable', 'recommended_plugins']
if not args.slash:
    command.append('resume')
env = dict(os.environ, CODEX_HOME=str(args.home.resolve()), TERM='xterm-256color')
if args.isolated:
    assert '_verification' in str(args.home.resolve())
    config_path = args.home / 'config.toml'
    if config_path.exists():
        config = tomllib.loads(config_path.read_text(encoding='utf-8'))
        provider = config.get('model_provider')
        assert provider == 'resume_test_provider', 'Refuse a non-test provider profile'
        assert config['model_providers'][provider]['base_url'] == 'http://127.0.0.1:9/v1'
    else:
        # All writes stay inside the explicitly selected private test home.
        # Cover both cwd spellings used by existing Windows client versions.
        cwd = str(args.cwd.resolve())
        config_path.write_text(
            'check_for_update_on_startup = false\n'
            'model_provider = "resume_test_provider"\n'
            '[model_providers.resume_test_provider]\n'
            'name = "Resume test"\nbase_url = "http://127.0.0.1:9/v1"\n'
            'wire_api = "responses"\n'
            + ''.join(f'[projects.{json.dumps(path)}]\ntrust_level = "untrusted"\n'
                      for path in {cwd, '\\\\?\\' + cwd}), encoding='utf-8')
    env['OPENAI_API_KEY'] = 'offline-resume-test-not-a-real-key'
    # Explicitly keep the copied-history test untrusted. This avoids onboarding
    # without trusting the user's project or loading its hooks/configuration.
    project_key = json.dumps(str(args.cwd.resolve()))
    command += ['-c', f'projects.{project_key}.trust_level="untrusted"']
    command += ['-c', 'model_provider="resume_test_provider"',
                '-c', 'model_providers.resume_test_provider.name="Resume test"',
                '-c', 'model_providers.resume_test_provider.base_url="http://127.0.0.1:9/v1"',
                '-c', 'model_providers.resume_test_provider.wire_api="responses"']
if args.powershell:
    shell = shutil.which('powershell.exe')
    assert shell, 'PowerShell is required for the external launcher check'
    invocation = '& ' + ' '.join("'" + value.replace("'", "''") + "'" for value in command)
    command = [shell, '-NoLogo', '-NoProfile', '-Command', invocation]
proc = PTY(150, 42)
proc.spawn(command[0], cmdline=' ' + subprocess.list2cmdline(command[1:]),
           cwd=str(args.cwd), env='\0'.join(f'{key}={value}' for key, value in env.items())+'\0')
chunks = []
screen = pyte.Screen(150, 42)
stream = pyte.Stream(screen)

def rendered_screen():
    return '\n'.join(screen.display)
def pump():
    try:
        while True:
            text = proc.read(65536, blocking=False)
            if not text:
                break
            if isinstance(text, bytes):
                text = text.decode('utf-8', errors='replace')
            chunks.append(text)
            stream.feed(text)
            if '\x1b[6n' in text:
                proc.write('\x1b[1;1R')
    except (EOFError, OSError):
        pass
    except WinptyError as error:
        if 'EOF' not in str(error):
            raise

def pause(seconds):
    until = time.monotonic()+seconds
    while time.monotonic() < until:
        pump()
        time.sleep(0.05)
def wait_for(predicate, seconds=45):
    until = time.monotonic()+seconds
    while time.monotonic() < until:
        pump()
        output = ''.join(chunks)
        if predicate(output):
            return output
        if not proc.isalive():
            break
        time.sleep(0.1)
    raise AssertionError('Terminal expectation failed; inspect the private output log')
try:
    def composer_ready():
        rendered = rendered_screen()
        return ('for shortcuts' in rendered or 'context left' in rendered
                or 'Ask Codex to do anything' in rendered) and 'Resume a previous session' not in rendered
    output = wait_for(lambda text: 'Resume a previous session' in text or '2. Skip' in text or (args.slash and composer_ready()))
    if '2. Skip' in output and 'Resume a previous session' not in output:
        # Decline the observed update prompt; never install through the test.
        proc.write('\x1b[B')
        pause(0.3)
        proc.write('\r')
    if args.slash:
        wait_for(lambda _: composer_ready(), seconds=90)
        # Match ordinary typing; a burst containing Enter is intentionally
        # treated as pasted text by Codex's paste guard.
        for character in '/resume':
            proc.write(character)
            pause(0.1)
        pause(0.3)
        proc.write('\r')
    wait_for(lambda _: 'Resume a previous session' in rendered_screen())
    wait_for(lambda _: 'No sessions yet' in rendered_screen() or '1 /' in rendered_screen())
    output = rendered_screen()
    assert '[Cwd]' in output and '[Active]' in output, 'Verify default project and active filters'
    assert 'No sessions yet' not in output, 'Default Cwd/Active picker remains empty'
    assert '1 /' in output, 'Wait for a populated picker before selecting a row'
    if args.select_id:
        for character in args.id:
            proc.write(character)
            pause(0.05)
        wait_for(lambda _: re.search(r'\b1\s*/\s*1\b', rendered_screen()) is not None
                 and args.id in rendered_screen())
    # Do not interact with login/trust/security prompts. Only select from the
    # already-observed session picker, then close without submitting a prompt.
    proc.write('\r')
    if args.expect_active_writer:
        wait_for(lambda _: 'already has an active writer' in ' '.join(rendered_screen().split())
                 and args.id in re.sub(r'\s+', '', rendered_screen()), seconds=90)
        if args.source:
            assert prefix_digest(args.source, source_size) == source_digest, 'Historical source bytes changed'
        print(json.dumps({'entrypoint': '/resume' if args.slash else 'codex resume',
                          'external_powershell': args.powershell,
                          'default_cwd_active_nonempty': 'PASS', 'active_writer_guard': 'PASS',
                          'selected_session_restored': False, 'model_prompt_submitted': False,
                          'history_prefix_unchanged': 'PASS' if args.source else 'not_checked'}))
        sys.exit(0)
    wait_for(lambda _: composer_ready(), seconds=90)
    pause(0.5)
    proc.write('\x03')
    pause(0.5)
    proc.write('\x03')
    wait_for(lambda _: 'To continue this session, run:' in rendered_screen()
             and f'codex resume {args.id}' in rendered_screen(), seconds=20)
    # Check the actual rendered continuation command, not an ID that happened
    # to appear somewhere earlier in the picker/transcript output.
    assert f'codex resume {args.id}' in rendered_screen(), 'Restored the wrong thread'
    if args.source:
        assert prefix_digest(args.source, source_size) == source_digest, 'Historical source bytes changed'
    print(json.dumps({'entrypoint': '/resume' if args.slash else 'codex resume',
                      'external_powershell': args.powershell,
                      'external_conpty_picker': 'PASS', 'default_cwd_active_nonempty': 'PASS',
                      'selected_session_restored': 'PASS', 'model_prompt_submitted': False,
                      'history_prefix_unchanged': 'PASS' if args.source else 'not_checked'}))
finally:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(''.join(chunks), encoding='utf-8')
    args.output.with_suffix('.screen.txt').write_text(rendered_screen(), encoding='utf-8')
    if proc.isalive():
        proc.write('\x03')
        pause(1)
    # Release only the pseudo-console created by this test. No PID-based
    # termination or touching other terminals, clients or conversations.
    del proc
