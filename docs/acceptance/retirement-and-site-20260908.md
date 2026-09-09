# Apodex retirement and project site checkpoint

## Scope and status

This checkpoint implements the user's Apodex retirement and project-site/README work. It is **not the final release acceptance**. The existing full-trajectory and packaged installer gates remain open.

Apodex is removed from adapter registration, source discovery, provider indexing, new source/import admission, handoff launch, supported MCP/CLI provider choices, and skill roots/targets. Active session and memory searches exclude legacy Apodex rows. The enum remains solely for decoding existing catalogues without rewriting or deleting historical records. No external Apodex installation or source history was removed.

## Evidence

- `cargo test --workspace --all-targets --no-fail-fast --quiet`: PASS after updating retired-provider expectations. Rust test targets: 12, 5, 5, 38, 1, 1, 4, 1, 0, 3 tests. The two CLI binaries share tests; do not count those as independent product flows.
- `cargo test -p mydesk-core --test retired_provider --quiet`: PASS (1). Checks legacy deserialization and rejection before source-file read.
- `pnpm --dir apps/desktop check`: PASS.
- `pnpm --dir apps/website build`: PASS.
- Website browser interaction: 1440px and 390px, no horizontal document overflow; clicked install anchor and expanded source instructions. QA screenshots at `D:\AcceptedArtifacts\Mobius-Verification-20260908-real\website-{1440,390}.png`. Initial screenshots prompted a fix for the offscreen skip-link capture and the old multicolor logo; they precede those fixes.
- `pnpm tauri build --debug --no-bundle`: PASS after closing the previous owned verification window that locked the executable. This embeds the frontend and avoids development HMR; it is not an installer or optimized release.
- The isolated full-desktop UI regression initially failed because it still expected 5 providers. The test now expects 4 and asserts Apodex is absent from source-provider choices. Rerun `frozen-retire-apodex-02`: **1 integrated UI flow passed in 44.5 seconds**, using the embedded-frontend desktop binary and fixture Harnesses. Evidence: `E:\Workspaces\Mobius-Verification-20260907-v03\runs\full-control-audit-20260908-70\playwright-control-audit-frozen-retire-apodex-02`. This is not a real-model trajectory or installer test.

## Remaining mandatory gates

1. Full chronological trajectory with tool attempts/results, precise provenance, multi-hop and branching continuity, and explicit size/omission disclosure. Existing selected-message handoff is not sufficient.
2. Real Pi/Grok launch-wrapper compatibility and resume; real-session reference/MCP/Mome coverage.
3. Every control across both themes, native dialogs, persistence/restart, terminal cleanup, media/network failures and recovery, beyond a fixture flow.
4. Optimized installer install/launch/upgrade/uninstall isolation and dependency/license inventory.
5. Video script approval followed by real release-build capture; no marketing recording before approval.

## Design and publication boundaries

Project website follows Blume's product-first presentation, with independently authored grey/navy retro UI illustrations inspired by Retro Windows. It does not claim the illustrative sessions are screenshots. README contains installation, capabilities, known limitations, licensing and research links. The project manifest already declared MIT; LICENSE now supplies the text. Third-party binary/license inventory is still a release gate, not marked complete.
