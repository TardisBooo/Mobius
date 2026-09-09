# Real desktop acceptance — 2026-09-08

Status: INCOMPLETE / release blocked. This report supersedes any inference that fixture smoke tests establish real Harness compatibility.

## Environment and evidence

- Application: native Tauri/WebView2 debug executable; CDP 9348, actual PowerShell/ConPTY. Frontend changes were hot-reloaded, so this is NOT packaged-release verification.
- Disposable project: `E:\Workspaces\Mobius-Verification-20260908-real\workspace`.
- App storage: `D:\DataVault\Mobius-Verification-20260908-real` and `D:\Catalog\Mobius-Verification-20260908-real`.
- Screenshots and rendered terminal text: `D:\AcceptedArtifacts\Mobius-Verification-20260908-real`.
- Driver: `apps/desktop/tests/real-desktop-audit.cjs`; clicks, keyboard input and DOM observation only, no mocked responses or backend state injection.
- Harness invocations used existing credentials/configuration, real network requests and new real sessions. No credential values are recorded in this report.

## Observed results

| ID | Operation | Result | Evidence / limitation |
|---|---|---|---|
| REAL-01 | First-run guide next + skip | PASS, subset | `onboarding-sources.png`; remaining guide controls NOT_RUN |
| REAL-02 | Register project then immediately create PowerShell | FAIL → fix implemented | Initially cwd was `E:\Workspaces`; backend-current project lookup added. Subsequent terminal is correct (`powershell-cwd-regression.txt`). Fresh first-registration regression still required. |
| REAL-03 | Codex real prompt/reply | PASS | `codex-trusted-response.txt`; Codex 0.153.4, gpt-5.6-sol low |
| REAL-04 | Claude real prompt/reply | PASS | `claude-response.txt`; Claude Code 2.1.251, configured model glm-5.3 |
| REAL-05 | Pi real prompt/reply | PASS | `terminal-3.txt`; Pi 0.84.4, DeepSeek V4 Flash |
| REAL-06 | Grok real prompt/reply | PASS | `grok-start.txt`; configured model DeepSeek V4 Flash |
| REAL-07 | Apodex real startup | BLOCKED | `apodex-start.txt`; external native runtime fails symlink creation with WinError 1314. No privilege escalation or sandbox disabling. |
| REAL-08 | Switch between real Harness terminal tabs | PASS, subset | `terminal-0` through `terminal-3`; outputs remain available. Long soak, closure/restart coverage still pending. |
| REAL-09 | Find real Codex/Claude/Pi IDs in session UI | PASS | Correct provider IDs and source messages found; title quality FAIL (Codex title taken from injected AGENTS.md). |
| REAL-10 | Switch session while reader loads | FAIL → fix implemented | New title briefly displayed previous session messages. Reader now filters by selected session ID before allowing reference/handoff. Dedicated latency regression still pending. |
| REAL-11 | Resume actual Codex via UI; ask prior decision | PASS | `codex-resume-verified.txt`, `codex-resume-memory-result.txt`; answer retains 3 frames, rejected 30 due to lag, next pause/resume test. |
| REAL-12 | Resume actual Claude via UI | PASS, restoration only | `claude-native-resume.txt`; prior messages restored in correct project. New-turn continuity NOT_RUN. |
| REAL-13 | Resume actual Pi via UI | FAIL | `pi-native-resume.txt`; local wrapper rejects `--resume`. Underlying Pi CLI also requires `--session ID`, not picker `--resume`. Argument fixed in source/unit test; wrapper compatibility remains unresolved. |
| REAL-14 | Resume Grok / Apodex via UI | NOT_RUN / unsupported | Current app does not expose verified native resume for these providers. This is a product coverage gap, not PASS. |
| REAL-15 | Codex → Claude actual handoff | PASS, selected-message only | `handoff-response.txt`; target reads exact packet, retains decision/reason/next step. Required two explicit read-related approvals. |
| REAL-16 | Claude → Codex actual second hop | PASS, selected-message only | `second-hop-start.txt`; target retains decision/reason/next step. App used configured default gpt-6-astra low. It also listed the disposable directory read-only. |
| REAL-17 | Real target correlation / two-hop graph | PASS | `real-handoff-graph.png`; one chain, two edges, actual Codex/Claude/Codex nodes. |
| REAL-18 | Full trajectory, tool evidence, long-context truncation and branches | NOT_RUN / incomplete implementation | Passing a selected message is insufficient to prove this requirement. |
| REAL-19 | Real-session precise reference / explicit Mome / MCP | NOT_RUN | Fixture results do not transfer to this gate. |
| REAL-20 | Real media URLs, canvas clipboard/undo/persistence, all note/mount controls | NOT_RUN in this run | Earlier local UI smoke is separate evidence; not full real coverage. |
| REAL-21 | Every control in both themes / contrast / keyboard / native pickers | NOT_RUN in this run | Earlier control geometry checks are insufficient. |
| REAL-22 | Packaged EXE / install / restart / close and child cleanup | NOT_RUN | Do not release this checkpoint as accepted. |
| REAL-23 | Actual titlebar Close | PASS, process exit only | Clicked `.window-close` in CDP 9348 instance. App PID 9828, WebView PID 63496 and listener 9348 no longer exist. Complete descendant cleanup was not instrumented; not claimed. |

## Test invalidation and safety incident

The first Codex invocation used `E:\Workspaces` because of REAL-02. It was instructed not to use tools or modify files and returned only the marker; its session is excluded from valid results.

During a frontend hot reload, selection reset before an ad-hoc resume click and an unrelated pre-existing Codex transcript was opened. The terminal was closed without sending a new task. No complete before/after source hash baseline was captured, so this run cannot prove that the Harness wrote no resume metadata. This attempt is INVALID and excluded from REAL-11. The successful rerun checks the exact reader session ID before clicking resume. Further comprehensive runs must use a frozen build and narrowly isolated session sources, rather than broad historical roots.

## Remaining release gates

No aggregate “all passed” status until every row in `desktop-smoke-matrix.md` has real evidence, unresolved failures above are fixed/retested, and the frozen packaged binary is tested. The user subsequently requested removal of Apodex support: its historical failed test remains recorded above, but Apodex is no longer a release target. Do not alter or uninstall the user's external Apodex installation.
