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

- Rendered companion UI was inspected through the authenticated isolated host on 2026-11-11. Home displayed migrated memory/review counts and schedule; persona and settings rendered. Autonomous planning, real activities and runtime background switches remained off. This is browser UI evidence, not Desktop registration. Native Desktop registration remains blocked by failure to activate its open folder picker.
- Full host captures completed for 14:00 and 22:40, each with Prompt Engine off and active. Wardrobe snapshot text was byte-identical across modes (195 and 181 characters respectively), with distinct daytime-everyday and night-window results. Captures used synthetic local completion and isolated temporary data. The system rule references the snapshot heading; actual outfit context appears once in the user message. Evidence: ignored data/logs/integration-day-night/summary.json and four request captures.
- G3 mirror-observe implementation and synthetic host loop completed; see docs/18-mirror-observe-integration.md. Real traffic and decision-quality evidence remain outstanding.
- Real model conversation, billed images and real QQ delivery remain unverified.
- Migration scope confirmed: standard assets only; no additional chat/media copy is required.

Private reports and launch records remain in ignored data directories.

## Final regression pass

Mirror reload now revalidates the path/transport boundary before reconnecting. Observation instances skip reset-command handling and approval receipt polling. Targeted transport, pipeline and section tests: 38 passed, zero failures. Full verify after these edits: unit 9, static 38, compose 1 passed; one package has no tests. Logs: data/logs/mirror-reload-regression.log and data/logs/verify-integration-final.log.
