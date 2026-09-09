# Third-party notices and inspiration

Möbius project code is offered under the [MIT License](LICENSE), matching the existing workspace manifest. Third-party components retain their own copyrights and licenses; this file does not relicense them. MIT is a copyright license, not a Windows code-signing certificate.

## Product and interaction research

These links acknowledge research and inspiration, not ownership, endorsement, or blanket permission to copy code or assets.

| Source | Research topic |
| --- | --- |
| [Blume](https://blume.codes/) | Agent-focused product communication and focused workflows |
| [AionUi](https://github.com/iOfficeAI/AionUi) | Open-source landing-page information hierarchy, bilingual README navigation and feature documentation patterns |
| [Retro Windows](https://designmd.app/library/retro-windows) | Grey system surfaces, navy title bars, inset/outset controls |
| [Noteey](https://www.noteey.com/) / Apple Freeform | Spatial notes and media organization |
| [OpenCove](https://github.com/DeadWaveWave/opencove) | Canvas and workspace interaction research |
| [agentsview](https://github.com/kenn-io/agentsview), [open-agent-view](https://github.com/xhluca/open-agent-view), [cetus](https://github.com/drewnekota/cetus) | Multi-harness session organization |
| [Memmy](https://github.com/MemTensor/memmy-agent), [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) | Context and task continuity |
| [Prewalk](https://stencil.so/blog/prewalk) | Passing a trace of work rather than only a summary |
| [SkillKit](https://github.com/robotbird/skillkit) | Skill management workflows |
| [QPeach](https://github.com/Huu-Yuu/QPeach) | Frameless desktop window research |
| [Kate Loseva: Hero section design](https://x.com/loseva_pro/status/2023416480759705888) | Editorial hero composition, monochrome scan-line motion and restrained navigation |
| [session-index-viewer](https://github.com/CheerChen/session-index-viewer), [Obelisk](https://github.com/tommy0103/obelisk), [llm_wiki](https://github.com/nashsu/llm_wiki) | Session indexing and knowledge organization |

Research checkouts under `.research/repos` are not tracked or bundled as Möbius source. Their licenses must be reviewed separately before incorporating any implementation. No external logos or screenshots from these products are included in the new product page; its product screenshots use the actual Möbius interface with fictional demonstration data.

## Dependencies and release gate

The English light-mode product film uses actual Möbius UI with fictional demonstration data. Its motion code adapts [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft), Copyright 2026 Wei Yihao, under Apache-2.0. The [license copy](licenses/video-shotcraft.txt), modification notices and [image/music provenance](licenses/MEDIA-CREDITS.md) are retained here alongside the embedded product media. Stock media/music retain their respective licenses and are not relicensed under Möbius's MIT license.

The application uses Tauri, React, xterm.js, React Flow, Lucide, react-markdown and the Rust packages listed in the lockfiles. Installed package license files and upstream copyright notices remain authoritative. This is not yet an exhaustive binary dependency notice inventory.

Before declaring a distribution accepted, generate an inventory from `Cargo.lock` and the frontend lockfile, retain required license texts (including fonts/assets if added), and review the bundled installer contents. Do not treat this document as proof that that release audit has passed.

Möbius is not affiliated with the named products or model providers. Provider names identify interoperability only. Model subscriptions, API terms, and the user's installed Agent CLIs are separate from the Möbius license.
