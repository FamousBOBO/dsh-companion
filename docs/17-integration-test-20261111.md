# Integrated test environment — 2026-11-11

The development branch combines main (group runtime and song updates), reminder round 2, Prompt Engine refinements, and visual identity / wardrobe v2. Original checkouts retain all local edits; source snapshots were saved before integration. Nothing was pushed or deployed to production.

## Evidence

- npm ci and build passed on Node 24.14.0 / npm 11.9.0.
- Full verify with fixture persona: unit 9 passed, static 38 passed, compose 1 passed (199 loader lines). Paste-search has no tests.
- Preset and wardrobe regressions: 13 passed. Prompt Engine activation preserves wardrobe text byte for byte and appends style after facts.
- Group evaluation: 49 PASS, 0 FAIL, 3 existing model-dependent WARN (G06/G10/G41). Evaluator self-tests, channel layers and size checks passed.
- Existing installed Desktop runtime 0.2.2-rc.1 was extracted into ignored test data with its runtime support payload. This local arrangement does not distribute a host.
- Missing companionGroupPersona and companionGroupMemory isolate declarations were added after the actual host rejected session creation.
- Authenticated homepage, memory summary and companion state returned HTTP 200; business APIs succeeded. Preset listing and companion session creation succeeded. No model prompt was submitted.

## Migration

Standard CLI export reported stopped source, no warnings. A dry-run preceded identity-adopt import of six files into isolated test data. Production persona id was preserved; persona text was copied after backing up the target template.

Source and target quick_check passed. Aggregate table row counts matched: memory 11394, runtime 13262, health 4976. These totals are not counts of individual memories. Every source table count was preserved. Imported reminders do not replay; health consent is reset.

Fresh test settings retain disabled external sends, health collection and billing. Standard migration excludes credentials, chat history, media files, private logs and desktop login caches. On 2026-11-11 the user explicitly selected standard assets only; additional chat history, images and voice are outside the requested migration scope. The standard migration is complete with the integrity evidence above.

## Remaining

- Rendered companion UI was inspected through the authenticated isolated host on 2026-11-11. Home displayed migrated memory/review counts and schedule; persona and settings rendered. Autonomous planning, real activities and runtime background switches remained off. This is browser UI evidence, not Desktop registration. The earlier open-folder-picker blockage has since been resolved by the user, who added this worktree as a desktop workspace (see "Desktop workspace registration" below).
- Full host captures completed for 14:00 and 22:40, each with Prompt Engine off and active. Wardrobe snapshot text was byte-identical across modes (195 and 181 characters respectively), with distinct daytime-everyday and night-window results. Captures used synthetic local completion and isolated temporary data. The system rule references the snapshot heading; actual outfit context appears once in the user message. Evidence: ignored data/logs/integration-day-night/summary.json and four request captures.
- G3 mirror-observe implementation and synthetic host loop completed; see docs/18-mirror-observe-integration.md. Real traffic and decision-quality evidence remain outstanding.
- Real model conversation, billed images and real QQ delivery remain unverified.
- Migration scope confirmed: standard assets only; no additional chat/media copy is required.

Private reports and launch records remain in ignored data directories.

## Final regression pass

Mirror reload now revalidates the path/transport boundary before reconnecting. Observation instances skip reset-command handling and approval receipt polling. Targeted transport, pipeline and section tests: 38 passed, zero failures. Full verify after these edits: unit 9, static 38, compose 1 passed; one package has no tests. Logs: data/logs/mirror-reload-regression.log and data/logs/verify-integration-final.log.

## Takeover acceptance pass (2026-11-11, second handover)

Scope checked before running anything: the worktree is the isolated integration checkout, branch `codex/companion-test-integration`, HEAD `ff174aa`, clean tree at handover. The production checkout was only read with `git status` (unchanged, still on `main` at `e2bde2c` with its own pre-existing local edits). No production file, service or credential was touched.

Test host reused as-is: installed Desktop runtime `0.2.2-rc.1` extracted under `data/host-runtime`, profile `companion-integration` under `data/home/profiles`, data root `data/`. Nothing was re-installed or re-migrated.

### Real host turn against the migrated assets, local synthetic model

A real `companion-integration` host instance was booted against a **copy** of the migrated data root (so the migrated home stays untouched), with the default model route overlaid onto a loopback recorder that writes the complete request body and answers with a synthetic streamed completion. One real `session/create` + `session/prompt` turn was driven over the authenticated API; the scripted model called four companion tools in sequence (`companion_identity`, `companion_recall`, `companion_schedule_today`, `companion_life_status`). A second, wider run probed fifteen read-only tools across two runtime configurations. Nothing left `127.0.0.1`; no billed provider was contacted.

| Check | Result | Evidence (ignored) |
|---|---|---|
| Host boots the integrated profile with migrated data, no activation errors | clean; persona id matches the migrated one, `memory backend=sqlite`, agenda service read-back `provide/hit` | data/tmp/companion-session-acceptance/host.log |
| Migrated persona reaches the request | 50 of 50 distinctive persona lines present verbatim; longest shared run 205 chars; system prompt 7,158 chars | data/tmp/companion-session-acceptance/analysis.json |
| Migrated identity binding is what the session uses | `companion_identity` returns the migrated owner id, the migrated persona id, `mode=local-owner`; runtime copy of `identity.json` preserves the same owner id | same file, `identity` block |
| Memory recall works on the migrated database | `companion_recall` returned 5 rows (keyword+semantic), labelled `astrbot_import/imported_fact`, `astrbot_import/bot_action`, `extracted/user_utterance_not_verified_fact`; `/api/companion-memory/summary` HTTP 200 | same file, `memory` block |
| Injected context sections | last user block carries `【当前用户身份绑定】` / `【长期记忆资料】` / `【当前穿着】`, 1,204 chars; total injected 2,247 chars | data/tmp/companion-session-acceptance/captures/request-001.json |
| Switched-off capabilities answer as off, not as working | `companion_schedule_today` → `runtime-off`; `companion_life_status` → planning/activities `disabled`; `companion_heartbeat_status` → `disabled`; `companion_pulse` → `health-pulse-unavailable`; `companion_health_*` → `health-read-denied`; `companion_visual_state` → `identity-missing` with `missing:["identity"]` | data/tmp/companion-capability-matrix/analysis.json |
| Migrated schedule is readable, reminders are not replayed | runtime switched on in the matrix run: `companion_schedule_today` lists the 2 migrated agenda items with `reminderDelivery: not-wired`, authorizations `reminder`/`plan`, zero occurrences in the current window (the migrated one-shot occurrences expired and are not replayed) | same file, `runtime-active` case |
| Tool surface stays the companion set | 47 tools; no `qq_*`, no `expression_*`, no media/bili tools | same file, `prompt.toolCount` |

These are `host-load` observations of what the host actually sends and what the tools actually answer. They are **not** real-model quality evidence: the completion is a fixed synthetic string, so nothing here says the writing is good.

### Two defects found and fixed

1. **Switched-off capability reported as still loading.** With the cognitive runtime off (the state the standard migration leaves behind), `p2Status()` returned `state:'pending-load', pendingLoad:true` for both P2 halves even though `p2.planning.enabled` and `p2.activities.enabled` were false. The companion therefore told the model "planning/activities are still loading" instead of "disabled", which is exactly the "don't report a switched-off capability as running" rule. Contract §12.5.10 and `lib/diagnostics.mjs` reserve `pending-load` for "switch on, code not mounted yet". Fixed in `plugins/companion-runtime/index.mjs`; regression test added in `test/p2-boundaries.test.mjs` covering both halves (switch off → `disabled`; switch on + unmounted → `pending-load`). Verified again through the real host: the same probe now answers `disabled`. Runtime package: 698 tests pass.
2. **Three reminder guards were timing-flaky.** `plugins/dsh-channel-qq/test/round15-halt.test.ts` waited a fixed `sleep(150)` before asserting that the first beat really sent, so a busy machine (temporary directory + Defender scan) produced false reds; across the takeover round the same file produced one `P1-16.1` and one `P1-17.2` failure in otherwise-identical runs. The "first beat happened" precondition now uses the existing real-time `waitUntil` helper; the negative assertions keep their fixed delay, because proving "nothing happened during this window" is the point. Same file passes five consecutive runs and the full 1,818-test channel suite passes three consecutive runs.

### Full offline verification (fixture persona)

`DSH_COMPANION_PERSONA_ID=bot npm run verify` → `unit` 9 passed / 0 failed / 1 package without tests; `static` 38 passed / 0 failed; `compose` 199 loader lines. Per module: foundation 460 pass / 9 skipped, memory 261 pass / 7 skipped, runtime 698 pass, channel-qq 1,817 pass / 1 skipped, expression 214 pass, media 162 pass, health 212 pass / 1 skipped, group 18 pass, memory-studio 173 pass. Log: data/logs/verify-takeover-final2-20261111-162329.log.

Without the fixture persona id the same run shows three environment-only failures (foundation, memory-studio, channel-qq), exactly the family `docs/07` §4.1 documents: they read the local `config/suite.json` whose `persona.id` is the migrated id and whose `qqIdleCompaction` is false. They are not regressions, and the report must not present the unqualified run as green or as red.

### Zero-cost wardrobe capture re-run

`node scripts/wardrobe-acceptance.mjs --root data --out data/logs/wardrobe-v2-20261111` reproduced the day/night table against the migrated data root: five scenes available, 14:00 `everyday` and 22:40 `sleep` produce different English clothing clauses, network attempts none (dryRun only). The script seeds synthetic wardrobe/identity files on first run; those three files were **moved out** of the migrated data root to `data/tmp/wardrobe-acceptance-seeds/` so the migrated state stays exactly as the migration left it (no visual identity configured, which is why `companion_visual_state` correctly answers `identity-missing`). Evidence: data/logs/wardrobe-v2-20261111/acceptance.json.

### Desktop workspace registration (corrects the earlier "blocked" statement)

The earlier reports said native Desktop workspace registration was blocked because the open-folder picker could not be activated. That no longer describes the current machine: the user has since added this worktree as a desktop workspace. The desktop workspace registry (`<DSH_HOME>/storages/workspace.json` of the desktop app) contains an entry whose path is this worktree and whose title is `dsh-production` (workspace id recorded there next to the production and default workspaces). What this does **not** change: it is a desktop-shell registration, so it says nothing about real model quality, real sends, billed images or health hardware — those are still unverified, and the acceptance evidence for them is unchanged.

### Still unverified / user-triggered

- Real model conversation quality (a real provider key and a real turn): needs the operator's own key; not run.
- Billed image generation and TTS: need explicit operator authorization per request.
- Real QQ send / group live / Bilibili send: need a logged-in OneBot sidecar and real targets; the integrated config keeps QQ disabled.
- Health cloud sync and BLE heart rate: need a real account / device.
- Mirror-observe against real traffic: still synthetic only, per docs/18.

Private capture bodies, launch records and the acceptance harness scripts stay in the ignored `data/` tree; this report carries statistics only.
