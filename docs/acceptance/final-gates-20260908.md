# 0.3.8 corrective acceptance — real Harness and installer gates

Status: **PARTIAL / NOT release-wide acceptance**. Full trajectory, Pi and installer lifecycle passed the checks below. Grok passed a real new-turn resume before packaging, but its installed-build new-turn repeat is blocked by the configured service's credit-limit screen. Do not mark that repeat PASS.

## Boundary and method

- Source: `E:\Workspaces\Mobius-20260907`.
- Disposable project only: `E:\Workspaces\Mobius-Verification-20260908-real\workspace`.
- Copied test Harness histories: `E:\Workspaces\Mobius-Verification-20260908-final\harness-home`. Only the two named prior acceptance sessions were copied; no existing project was used for writes. Grok's existing model config was copied into the isolated home without printing its contents.
- Vault / evidence / catalog: `D:\DataVault`, `D:\AcceptedArtifacts`, `D:\Catalog`, each under `Mobius-Verification-20260908-final`.
- UI: real Tauri WebView2 over CDP 9351, clicked controls and entered prompts in native PowerShell/ConPTY. No backend invocation injection or mocked model responses. Frozen frontend, no HMR.
- Installer: real NSIS processes in silent mode, explicit destination `E:\Workspaces\MyDesk\production\lifecycle-verification-20260908`. This verifies installation operations, not every visible wizard control. Existing unrelated installations were not touched.

## Failures found and corrections

1. Installed Pi/Grok OpenAgents wrappers did not forward native resume arguments. Möbius now recognizes that exact wrapper protocol read-only and launches the installed native runtime with its configured model. No external wrapper was modified. Unrecognized launchers retain their ordinary launch path; this is not a claim to support every third-party wrapper.
2. Grok's native UUID and cwd live in its session directory / `summary.json` companion. Adapter `grok-history-v3` uses that metadata and exposes verified native resume; Pi receives its exact source file via `--session`.
3. Selected-message handoff was not a full trajectory. Explicit full-trajectory preparation now snapshots the entire original source, preserving tool calls, results, failed attempts, native event IDs and order. A later hop includes the sealed ancestor plus the current native session. The searchable sampled catalogue is not used as the trajectory.
4. Environment-variable-only packet lookup failed in Pi's Windows tool environment. The prompt now supplies a direct readable file path. Sources are also available individually as their exact native bytes, avoiding one huge escaped JSON string. SHA-256 and byte equality are checked before launch.
5. Test selectors could confuse a native ID mentioned in another transcript with that transcript's own ID. The real UI driver now verifies the dedicated native-ID field exactly before resume or handoff.

## Evidence table

All artifact filenames below are relative to `D:\AcceptedArtifacts\Mobius-Verification-20260908-final`.

| Gate | Result | Actual evidence |
|---|---|---|
| Pi native resume, real API answer | PASS | `pi-resume-answer.png/.txt`: recalled 3 frames and rejected 30 due to lag. Native ID `01a080f5-d930-7c38-87a5-9bab3ba65b43`. |
| Grok native resume, real API answer before packaging | PASS | `grok-resume-answer.png/.txt`: `MOBIUS_GROK_RESUME_VERIFIED`, same decision/reason. Native ID `01a080f5-f309-7cc2-a0f8-8c25f74b9b74`. |
| Actual failed tool attempt, correction and read-back | PASS | `pi-trace.png/.txt`: missing `trace-attempt.txt` -> ENOENT, write `trace-proof.txt`, read back `buffer=3; rejected=30; reason=lag; next=measure-p95`. |
| Pi -> Grok -> Pi full source continuity | PASS, bounded actual trace | `grok-trace-read.png/.txt`, `installed-pi-trace-progress.png/.txt`; final Pi `01a08164-b76c-7695-9658-b1c4bd471f4c` reads both sources and verifies state without repeating the write. |
| Exact full tool-read content, not a summary claim | PASS | `real-trajectory-integrity.json`: original Pi 9,384 bytes and Grok 42,790 bytes each equal the target's actual read-tool output and snapshot SHA-256. Repro: `node tests/acceptance/verify-real-trajectory.cjs`. |
| Correlated graph across restart/upgrade | PASS | `real-handoff-graph.png`: one chain, three edges (including the earlier failed Pi attempt, preserved honestly as a real created session). |
| Installed 0.3.8 Pi native resume + new turn | PASS | `installed-pi-verified.png/.txt`: `MOBIUS_INSTALLED_PI_VERIFIED`, buffer/rejection/failure/next step recalled. |
| Installed 0.3.8 Grok native history restore | PASS | `installed-grok-ready.png/.txt`, native process runs `--model deepseek-v4-flash --resume` with the exact UUID. |
| Installed 0.3.8 Grok new-turn repeat | **BLOCKED** | `installed-grok-verified.png/.txt`: native credit-limit UI. Despite this artifact's stage name, its outcome is NOT verified. No purchase, account switch or quota bypass attempted. Requires service access/credits before rerun. |
| Real 0.3.7 installation | PASS | `installer-install-old.json`: exit 0, registered, file version 0.3.7; `installed-old-launch.png/.txt`. |
| Real 0.3.7 -> 0.3.8 upgrade | PASS | `installer-upgrade.json`: exit 0, registered, file version 0.3.8. |
| Clean 0.3.8 install after uninstall | PASS | `installer-install-new.json`: exit 0, correct version/hash, preserved-data inventory unchanged; `installed-clean-install-note.png` confirms existing note content in the reinstalled UI. |
| GUI note persistence after upgrade and clean restart | PASS | `installed-old-note.png`, `installed-upgrade-note.png`, `installed-clean-restart-note.png`; saved text retained. Tree displays the slug, not the original uppercase title (existing presentation limitation, not data loss). |
| Uninstall and preserved-data integrity | PASS | `installer-uninstall.json`: exit 0, executable and uninstall registration absent; complete before/after vault and copied-Harness file inventories identical. |

## Explicit limitations

- Full trajectory preparation is opt-in. No automatic cross-session search/injection was introduced. UI discloses source count, bytes, approximate token estimate and potentially sensitive tool output before confirmation.
- Maximum serialized snapshot 16 MiB. Malformed, changed-during-read, unavailable or oversized sources are rejected, not silently trimmed. Target context/tool limits still apply: the launch instruction requires reading to EOF and disclosing any inability, not pretending completion.
- Byte-preserving native histories include model-native records. They are local historical data, not authority for new actions. No code converts them into another provider's native session format or overwrites the old session.
- Real Pi Bash attempts revealed an existing WSL `/bin/bash` failure. Pi read/write tools and resume work; the handoff no longer needs Bash to find its files. This report does not certify Pi's external shell environment.
- Original selected-message-only legacy handoffs cannot be relabeled complete. Attempting to extend such an ancestor as a full chain produces an explicit error.
- 67 Rust unit tests passed (`cargo test --workspace --lib --bins`), TypeScript/build passed. These supplement, not replace, the actual UI/native tests above. This is not blanket coverage of every control or every provider/version.

## Remaining action

Restore usable credits/access for the existing Grok configuration, then repeat the installed Grok new-turn check in the copied session. Until its actual response is captured, the three-gate request is not fully accepted. Video recording remains pending the user's separate script approval.
