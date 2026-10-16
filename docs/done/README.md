# Completed implementation plans

Screened against the current `develop` checkout on 2026-10-15.

These are historical plans, handoffs and reviews whose implementation scope is present in the source. Some still say “plan only”, “uncommitted” or “not merged”: those statements describe the original run, and are preserved as history. The evidence below records why each group was archived.

**Archived does not mean live-tested.** Existing manual QA, platform checks and `UntestedTag` records remain authoritative. No QA boxes or feature verification tags were cleared.

## Archive

| Work | Documents | Evidence checked |
|---|---|---|
| Headless owner | [headless owner plan](headless_owner_plan.md), [headless owner handoff](headless_owner_handoff.md), [headless owner review](headless_owner_review.md), [headless owner merge](headless_owner_merge.md) | `src-tauri/src/services/workspace.rs`, `mobile_control/headless.rs`, `scheduler.rs` and `alarms.rs`; `docs/server.md` calls this groundwork merged and user-verified. Later MCP parity work stays active. |
| macOS / Windows completion | [macos windows completion plan](macos_windows_completion_plan.md), [macos windows completion handoff](macos_windows_completion_handoff.md) | A1–A9 and the final review are recorded in the handoff; `services/private_file.rs`, `services/win_links.rs` and the platform helpers are present. Runtime checks on hardware remain open in the backlog. |
| Markup questions MCP | [markup questions mcp plan](markup_questions_mcp_plan.md), [markup questions mcp handoff](markup_questions_mcp_handoff.md) | `src-tauri/src/services/markup_mcp.rs`, `commands/markup_mcp.rs`, desktop question helpers and phone question cards; P1–P4 and both reviews recorded in the handoff. |
| Markup tick and approve | [markup tick approve plan](markup_tick_approve_plan.md), [markup tick approve handoff](markup_tick_approve_handoff.md) | `markup_mcp::TOOL_DONE`, `approveMarks` in `mobile-web/src/markup/layer.ts`, and desktop/phone tick controls; P1–P3 and final review recorded. |
| Markup tools, round 2 | [markup tools plan](markup_tools_plan.md), [markup tools handoff](markup_tools_handoff.md) | Proofreading stamps and comments in the shared layer and Rust markup model, persisted undo in `markup/store.ts`, and desktop/phone controls; all three implementation sections are present. Later removal of colour meanings and automatic Submit pins is intentional. |
| Phone markup | [mobile pdf markup plan](mobile_pdf_markup_plan.md) | `mobile-web/src/components/MarkupView.tsx`, `pdfFrame/main.ts`, `src-tauri/src/services/mobile_control/markup.rs` and `markup_pdf.rs`; QA remains under 31bt. |
| PDF markup rounds | [pdf markup rounds plan](pdf_markup_rounds_plan.md), [pdf markup rounds handoff](pdf_markup_rounds_handoff.md) | `mobile-web/src/markup/submitState.ts`, desktop `usePdfMarkup.ts` and `commands/pdf_markup.rs`; phases A–C recorded complete. |
| PDF markup direct apply and Undo | [pdf markup direct apply plan](pdf_markup_direct_apply_plan.md), [pdf markup direct apply handoff](pdf_markup_direct_apply_handoff.md) | `src-tauri/src/services/markup_rounds.rs`, phone and desktop Undo controls; both phases and their reviews recorded complete. |
| Shared phone markup layer | [mobile markup shared layer plan](mobile_markup_shared_layer_plan.md) | Outbox origin/file-row handling, `markupOpen.ts`, `clearAll` and `markAnchors`, plus Clear all and previous/next mark controls in `MarkupView.tsx`. |
| Access per phone | [mobile device scoped access plan](mobile_device_scoped_access_plan.md) | `src/components/mobile/MobileAccessPicker.tsx`, `discovery::ScopeAccess` / per-device catalog filtering, push filtering and QA entry in `todo/group-h-crossplatform.md`. |
| Phone git overview | [mobile git overview plan](mobile_git_overview_plan.md) | `mobile-web/src/screens/GitSheet.tsx`, `src-tauri/src/services/mobile_control/git_overview.rs` and `MobileGitSheet.test.tsx`; QA recorded in group H. |
| Phone local model control | [mobile local model control plan](mobile_local_model_control_plan.md) | `mobile-web/src/screens/LocalModelsSheet.tsx`, `src/lib/mobileLocalModels.ts`, `mobile_control/local_models.rs` and its bridge/gate tests; QA 31by remains open. |
| Phone uploads | [phone upload plan](phone_upload_plan.md), [phone upload handoff](phone_upload_handoff.md) | `src-tauri/src/services/mobile_control/uploads.rs`, phone Upload here / Undo and desktop upload listing; steps A–E and final review recorded complete. |
| Phone files library | [mobile files library plan](mobile_files_library_plan.md), [mobile files library handoff](mobile_files_library_handoff.md) | `mobile-web/src/components/FilesLibrary.tsx`, `libraryView.ts`, `thumbs.ts`, favorites/recents/folder colours and backend folder counts; A1–A3 are present. |
| Overlay agent | [overlay agent plan](overlay_agent_plan.md) | `src/components/layout/OverlayAgentColumn.tsx`, `useOverlayAgent.ts`, `src/stores/overlayAgent.ts` and overlay agent tests; the plan records steps 1–8 as built. |
| Scaffold optimization | [scaffold optimization plan](scaffold_optimization_plan.md) | `SCAFFOLD_FILES`, `scaffold_history/` and legacy-template matching in `commands/projects.rs`, plus the agent hint service; A–D recorded landed. |
| Skills MVP | [skills plan](skills_plan.md) | `schema/skills.rs`, `services/skills.rs`, `commands/skills.rs`, `SkillsLibraryTab.tsx` and `SkillsLibraryView.tsx`; the implemented MVP includes personal scope. The speculative deferred list remains historical. |
| Token stats | [token stats plan](token_stats_plan.md) | `src-tauri/src/services/token_stats.rs` and recap token controls; the group-S ledger marks the Claude/Codex scope code-complete. More CLI readers are a separate backlog item. |
| TypeScript 7 | [typescript7 plan](typescript7_plan.md), [typescript7 handoff](typescript7_handoff.md) | `package.json` build scripts invoke `typescript-native` 7.0.2; TypeScript 5 remains for ESLint/editors; `TypeCheckGate.test.ts` covers that contract. |
| Vite 8 / Vitest 5 / Tailwind removal | [vite8 vitest5 migration plan](vite8_vitest5_migration_plan.md), [vite8 vitest5 handoff](vite8_vitest5_handoff.md) | `package.json` has Vite 8.3.3, plugin-react 6.1.1 and Vitest 5.0.0, with Tailwind removed; A1–A5 and final review recorded complete. Release/live verification notes are preserved. |
| GPU compositing | [gpu compositing plan](gpu_compositing_plan.md) | `src-tauri/src/services/webkit_gpu.rs`, the setting and launch wiring; implementation is recorded done under #2421. The future WebKitGTK 2.54 re-check stays open under #2422 and its investigation document stays active. |
| SyncTeX simplification | [synctex plan](synctex_plan.md) | `commands/synctex.rs` has native search, `input_tags`, nearest-line matching and path spelling; shared frontend notices, rotation math, timed highlights and stale-source filtering are present. |
| Side panel show/hide | [side panel ide toggle plan](side_panel_ide_toggle_plan.md) | `src/components/layout/SidePanel.tsx` and the docked-bar implementation (`9f6623b8`); the plan records implementation on develop. Live QA stays in group R. |
| Threat recheck fixes, 2026-10-04 | [threat recheck fixes plan](threat_recheck_fixes_plan.md), [threat recheck fixes handoff](threat_recheck_fixes_handoff.md) | Security ledger #2342–#2349 records each fix and the 2026-10-05 follow-ups; `api_proxy`, `git_push_mcp`, `markup_rounds`, held-directory drop-box access and `phone_origin` are present. The later threat recheck remains active. |
| Tab cost / scrollback / experimental default | [tab cost plan](tab_cost_plan.md), [tab cost handoff](tab_cost_handoff.md) | `src/lib/tabCost.ts`, `TabCostList.tsx`, `PdfLoadWarningHost.tsx`, `lib/terminal/scrollback.ts` and default-setting wiring; T1–T3 and final review recorded complete. The broader performance plan stays active. |

## Kept active after screening

- **Current screen:** `screen_2026_10_15_high_plan.md` has a current follow-up round, and the medium plan is new. Both and their screen/handoff stay in `docs/`.
- **Server:** hosted deployment/merge work and agent-key integration retain open decisions and operational checks; start at [server status](../server.md).
- **Security:** the later [2026-10-08 threat recheck](../threat_recheck_2026_10_08_plan.md) has open follow-ups and unreviewed areas. Cross-OS fencing, sandbox hardening and “safe for everyone” still contain unbuilt work.
- **Partial implementation:** API chat Part B, headless MCP phases 2–3, HPC phase 3, VM phases 5–6, worktree phases 3–4, UI unification tiers 2–3, group K phase 2 and broader codebase-review/performance follow-ups stay active.
- **Mobile:** the future-directions plan mixes implemented and deferred work. All-CLI access still uses the resumable-only filter, box parity is open, and server-backed speech is unbuilt.
- **Other open plans:** React 19 (the checkout still uses React 18), project rename, rename release B, repo root cleanup, Prompt Universe, browser/mail plans with remaining phases, local-driver Codex argument forwarding and markup fast-model F2.
- **GPU investigation:** [PDF GPU rendering checks](../pdf_gpu_rendering_check_plan.md) retain open host/2.54 checks; the shipped opt-in implementation plan is archived above.

Current guides, help, subsystem rationale, file maps, threat model and active backlogs remain in their existing locations.
