# MÖBIUS 0.3.19 self-test and interaction fixes

Date: 2026-09-16 (Asia/Shanghai)

## Scope

- Source: `E:\Workspaces\Mobius\repos\desktop`
- Isolated drag-demo: `E:\Workspaces\_verification\mobius-full-20260915\runs\provider-001\drag-demo`
- Living checklist: [self-test-checklist.json](self-test-checklist.json)

## Product fixes that close prior T/G rows

| Row | Cause | Fix |
|---|---|---|
| WB-02 | Selecting a project did not keep checkouts expanded after a later tree render | Selecting a workspace now re-adds it to the expanded set |
| WB-16 / LI-08 | Dialog header and footer both used the accessible name `Cancel` | Header is `Close dialog`; footer stays `Cancel` |
| LG-07 | `getByRole('Handoff graph')` failed when the tab showed an edge count | Inspector tabs now have exact `aria-label`s |
| CA-08 | Leaving the canvas did not wait for a dirty save | Back to Library awaits `save(true)` when the scene is dirty |
| SE-17 / SE-18 | Automated source round-trip was blocked by earlier dialog name collisions | Covered by `tests/self-test-checklist.spec.ts` after the dialog fix |

## Checklist maintenance

JSON is the source of truth. After a label or locator change, edit `self-test-checklist.json` and run:

```powershell
pnpm --dir apps/desktop sync:checklist
pnpm --dir apps/desktop check:checklist
```

`check:checklist` fails if Markdown is stale, IDs collide, the revision drifts from `Cargo.toml`, or the Playwright spec lost the locators that close the 0.3.19 T/G rows. Regenerating Markdown never invents rows.

The smoke config already includes `tests/self-test-checklist.spec.ts`, so later isolated smoke runs keep those rows without a separate command.

## Publication

- GitHub Release: https://github.com/TardisBooo/Mobius/releases/tag/v0.3.19
- Maintained install: `E:\SOFTWARE\Mobius\mobius-desktop.exe` FileVersion `0.3.19`
- Product site: http://8.137.87.76/mobius/ (release dir `/data/mobius/releases/20260916-v0319`)
- Crawler files: `/llms.txt`, `/robots.txt`, `/sitemap.xml`, `/pricing.md`
- Film: 32-second silent tour, `apps/website/public/media/mobius-product-film.mp4`

## Checks

- `pnpm --dir apps/desktop check`: PASS
- `pnpm --dir apps/desktop sync:checklist`: PASS — 58 rows
- `pnpm --dir apps/desktop check:checklist`: PASS
- Isolated drag-demo smoke against 0.3.18 identified the rows above; 0.3.19 includes the product fixes.
- `pnpm exec tauri build --bundles nsis`: PASS after removing a truncated WebView2 offline installer cache.
- Silent upgrade of `E:\SOFTWARE\Mobius`: exit 0; vault file count unchanged at 425.
