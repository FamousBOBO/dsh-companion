# Mirror observation integration — 2026-11-11

The channel now accepts an explicit connection.mode of mirror-observe. This is a test transport for the existing fake OneBot mirror, not a production connection mode. Defaults remain forward with an empty URL.

## Boundaries

- Startup requires a literal loopback ws URL, presence.mode=shadow, and DSH_MIRROR_PRODUCTION_ROOT naming an existing production root. Existing home and workspace paths are resolved through realpath and must lie outside that root and its ancestors.
- The OneBot client latches observation mode at construction and rejects all actions before socket access, including queries and unknown actions. Changing between observation and live transport requires a new client.
- Inbound mirror dispatch accepts only group message events. It skips normal observers, commands, notices, requests and chat logging.
- Group messages enter the lightweight ambient path only. Mentions and owner posts do not create conversational turns, download files or invoke STT. Only configured presence groups are observed.
- Presence mode is constrained to shadow or off for an observation instance; a live setting makes the observation decision runner inactive.
- The fake WS server remains an independent boundary: all actions are rejected there as well.
- Observation instances mount only persona, observers, platform and inbound sections. Background job sections, outbound tools and the admin server are not mounted.
- Reload revalidates the boundary before reconnecting. Inbound reset-command handling and approval receipt polling are disabled for observation instances.

## Evidence

- Mirror transport and path boundary tests: 4 passed, including a real loopback WebSocket connection receiving a group event while transmitting zero action frames.
- Pipeline regression suite: 24 passed, including mentions and owner posts with file/voice attachments entering ambient without IO or conversation submission.
- TypeScript library and test builds passed. Layer and size checks passed without raising baselines.

## Remaining before G3 acceptance

The actual DSH 0.2.2-rc.1 channel was booted against the fake WS in an isolated temporary home and workspace. Two synthetic group events reached it; the local completion recorder returned a valid join decision. The channel wrote presence-shadow.jsonl with mode shadow and the synthetic proposed message. Fake WS statistics: one connection, two delivered events, zero forbidden action attempts. All temporary host and recorder processes exited afterward. Evidence: ignored data/logs/integration-mirror-shadow-recorded and data/tmp/integration-acceptance/mirror-shadow-recorded/logs/presence-shadow.jsonl.

This establishes a synthetic host observation loop, not real model decision quality. Real traffic, restart behavior and broader malformed-frame cases remain for acceptance. Do not connect a real production OneBot socket.

The integrated test profile continues to have QQ disabled. No production connection or credentials were changed by this implementation.
