# dsh-channel-qq — vendored build (DSH companion)

Status: **build OK, module resolution OK, type-check OK, gates OK.**
Built: 2026-10-28 (Asia/Shanghai) · Node v24.14.0 · TypeScript 5.9.3

This directory is a vendored copy of the upstream plugin plus everything needed to
compile it against the installed DeepSeek Harness Desktop runtime.

**Upstream sources are no longer byte-identical: 2 files are patched** (three one-line
edits, both for upstream bugs that break the plugin in the real runtime — an invalid
JSON Schema that made every QQ turn fail with HTTP 400, and a missing `port <= 0` guard
that made `affectionPort: 0` bind a listener instead of meaning "off"). Hash-diff against
the snapshot: 331 of 333 `src/**/*.ts` files identical; the two exceptions are listed
with file:line and rationale in **§8 Local patches**, which is the section to re-apply
after an upstream update.

---

## 1. Provenance

| | |
|---|---|
| Upstream | `github.com/Aegink/dsh-channel-qq`, branch `main` |
| Source used | extracted tarball snapshot at `%TEMP%\qqplugin\dsh-channel-qq-main` (no `.git`, so no commit id; `git clone` is unusable on this host — TLS failure, tarball only) |
| Package | `dsh-channel-qq@0.1.0`, `type: module`, `main = build/lib/index.js` (`package.json:6`), `types = build/lib/types/index.d.ts` (`package.json:7`) |
| Vendored on | Windows host, `C:\Users\bobo\Documents\Bot\dsh-companion\plugins\dsh-channel-qq` |
| Host runtime | `C:\Users\bobo\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh` (`@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.3`) |

What was copied: `src/`, `assets/`, `deploy/`, `scripts/`, `test/`, `docs/`,
`tsconfig*.json`, `package.json`, `package-lock.json`, `cordis.patch.yml`,
`README/CHANGELOG/CONTRIBUTING/SECURITY/LICENSE`, dotfiles (`.editorconfig`, `.gitattributes`, `.gitignore`).

Deliberately **not** copied: `.git`, `.github`, `node_modules`, `eval/`
(`eval/` is the offline scoring harness; two test files need it, see §7).

---

## 2. Toolchain (exact versions used)

| Tool | Version | Where it comes from |
|---|---|---|
| Node.js | v24.14.0 | host |
| npm | 11.9.0 | host |
| pnpm | 11.22.0 | `C:\Users\bobo\AppData\Local\pnpm\bin\pnpm.ps1` |
| TypeScript | 5.9.3 | copied into `node_modules/typescript` (see §4 step 4) |
| @types/node | 22.20.5 | copied into `node_modules/@types/node` |
| @types/ws | 8.18.2 | copied into `node_modules/@types/ws` |
| undici-types | 6.21.0 | copied into `node_modules/undici-types` (`@types/node`'s optional global `fetch`/`Response` typings — without it every `Response` member reports TS2339) |
| peer runtime | `@deepseek-ai/cordis@4.0.5`, `@deepseek-ai/dsh-llm@0.2.1-rc.3`, `@deepseek-ai/dsh-attachment@0.2.1-rc.3` | installed Desktop runtime (§6) |

Upstream's `package.json` devDependencies pin the peers at `4.0.5-alpha.2` /
`0.2.1-alpha.2`. They are **not** installed here: the runtime runs `4.0.5` /
`0.2.1-rc.3`, and type-checking against alpha declarations while executing rc would
be misleading. Declarations are taken from the published releases that **match the
runtime exactly** (§6.3).

---

## 3. Build output

```
build/lib/        333 .js  (2,088,270 B ≈ 2.0 MB) + 333 .d.ts  → 2.65 MB total
build/lib-test/   416 .js  (test build, 3.29 MB) — optional, see §8
build/lib/index.js  ← package.json "main"; exports { ChannelQQ, default }
```

Whole plugin directory: 2,446 files / 35.8 MB, of which `node_modules` is 283 files / 25.4 MB
(the bulk is the copied TypeScript compiler), `vendor/types` is 0.73 MB, `assets` 0.09 MB.

Emitted peer imports are only three statements, all bare specifiers (runtime resolution
is not rewritten by the build):

```
build/lib/plugin.js:12              import { Service } from '@deepseek-ai/cordis';
build/lib/adapters/dsh-host/agent.js:15   import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
build/lib/adapters/dsh-host/skills.js:15  import { createUserMessage } from '@deepseek-ai/dsh-llm';
```

`ws` and `silk-wasm` are imported normally (`build/lib/.../onebot.js`, `.../edge.js`, `.../silk.js`).

---

## 4. Reproduce from scratch (exact commands, pwsh)

```powershell
$src  = 'C:\Users\bobo\AppData\Local\Temp\qqplugin\dsh-channel-qq-main'
$app  = 'C:\Users\bobo\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai'
$plug = 'C:\Users\bobo\Documents\Bot\dsh-companion\plugins\dsh-channel-qq'

# 1. copy sources (no .git / .github / node_modules / eval)
robocopy $src $plug /E /XD .git .github node_modules eval /NFL /NDL /NJH /NJS /NP

cd $plug

# 2. runtime dependencies only. Deliberately NOT `npm install` (see §8 note 9):
#    the full manifest would install the alpha peer closure (cordis 4.0.5-alpha.2,
#    dsh-llm/dsh-attachment 0.2.1-alpha.2) into this node_modules, which then
#    shadows the runtime's copies for non-profile mounts and gives the plugin a
#    second cordis instance. --prod installs `ws` + `silk-wasm` only.
pnpm install --prod --ignore-scripts --config.auto-install-peers=false --config.confirmModulesPurge=false

# 3. peer resolution layer B: junctions to the runtime's own copies (see §6.3)
$scope = "$plug\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force -Path $scope | Out-Null
foreach ($p in 'cordis','dsh-llm','dsh-attachment') {
  New-Item -ItemType Junction -Path (Join-Path $scope $p) -Target (Join-Path $app $p) | Out-Null
}

# 4. build-only toolchain (never written into package.json: upstream manifest stays pristine)
$tools = Join-Path $env:TEMP 'qq-build-tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
Set-Content "$tools\package.json" '{"name":"qq-build-tools","private":true,"version":"1.0.0"}'
Push-Location $tools
npm install typescript@5.9.3 "@types/node@^22.0.0" "@types/ws@^8.5.14" --no-save --ignore-scripts --no-audit --no-fund
Pop-Location
robocopy "$tools\node_modules\typescript"   "$plug\node_modules\typescript"   /E /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy "$tools\node_modules\undici-types" "$plug\node_modules\undici-types" /E /NFL /NDL /NJH /NJS /NP | Out-Null
foreach ($t in 'node','ws') {
  New-Item -ItemType Directory -Force -Path "$plug\node_modules\@types" | Out-Null
  robocopy "$tools\node_modules\@types\$t" "$plug\node_modules\@types\$t" /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

# 5. peer .d.ts for type-checking only, vendored under vendor/types/ (runtime never loads these)
$t = Join-Path $env:TEMP 'qq-types'; New-Item -ItemType Directory -Force -Path $t | Out-Null
Push-Location $t
npm pack "@deepseek-ai/cordis@4.0.5" "@deepseek-ai/dsh-llm@0.2.1-rc.3" "@deepseek-ai/dsh-attachment@0.2.1-rc.3"
foreach ($pair in @(@('deepseek-ai-cordis-4.0.5','cordis'),
                    @('deepseek-ai-dsh-llm-0.2.1-rc.3','dsh-llm'),
                    @('deepseek-ai-dsh-attachment-0.2.1-rc.3','dsh-attachment'))) {
  New-Item -ItemType Directory -Force -Path (Join-Path $t $pair[1]) | Out-Null
  tar -xzf "$($pair[0]).tgz" -C (Join-Path $t $pair[1])
  robocopy (Join-Path $t "$($pair[1])\package") "$plug\vendor\types\$($pair[1])" /E /NFL /NDL /NJH /NJS /NP | Out-Null
}
Pop-Location

# 6. build
node scripts/build-admin-html.mjs                       # regenerates src/admin-html.ts
node node_modules/typescript/bin/tsc -p tsconfig.build.json   # emits build/lib

# 7. verify (see §8)
node --input-type=module -e "await import('file:///C:/Users/bobo/Documents/Bot/dsh-companion/plugins/dsh-channel-qq/build/lib/index.js').then(m=>console.log('IMPORT OK', Object.keys(m)))"
```

`node scripts/build-admin-html.mjs` needs no dependencies. `tsc`, `check-size.mjs`
(the only script that `import`s `typescript`) and the test build need the copies from step 4.

---

## 5. `node_modules` contents

| Path | Origin | Needed for |
|---|---|---|
| `ws` 8.22.0 (→ `.pnpm/ws@8.22.0`) | pnpm, prod dep | runtime (OneBot WS client + admin WS server) |
| `silk-wasm` 3.7.1 (→ `.pnpm/silk-wasm@3.7.1`) | pnpm, prod dep | runtime (silk→WAV for speech-to-text) |
| `@deepseek-ai/cordis` | **junction** → runtime copy | runtime `Service` base class (must be the host's instance, not a second copy) |
| `@deepseek-ai/dsh-llm` | **junction** → runtime copy | runtime message helpers |
| `@deepseek-ai/dsh-attachment` | **junction** → runtime copy | not imported by `src/`; present because upstream lists it as a devDep and `dsh-llm`'s declarations reference it (§6.3) |
| `typescript` 5.9.3 | copied from `%TEMP%\qq-build-tools` | build + `scripts/check-size.mjs` |
| `@types/node` 22.20.5, `@types/ws` 8.18.2, `undici-types` 6.21.0 | copied from `%TEMP%\qq-build-tools` | type-check only |

Plus pnpm's own metadata: `node_modules/.pnpm/`, `.modules.yaml`,
`.package-map.json`, `.pnpm-workspace-state-v1.json`, and `pnpm-lock.yaml` in the
plugin root. `node_modules/` and `build/` are already git-ignored by upstream `.gitignore`.

> `pnpm install` (any re-run) may prune the manually added entries. Re-run steps 3–4
> after any `pnpm install`; the copy/junction commands above are idempotent.

---

## 6. Peer dependency resolution (why it works, what was added)

### 6.1 Problem

`src/` imports exactly two bare peer specifiers — `@deepseek-ai/cordis` (11 files) and
`@deepseek-ai/dsh-llm` (2 files); both are declared in `package.json:37-40`:

```json
"peerDependencies": { "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-llm": "*" }
```

Nothing is installed for them: the plugin is meant to borrow the host's copies. Two
different mechanisms make that true, and both are needed depending on how the plugin
is mounted.

### 6.2 Layer A — the host's profile runtime interception (used when the plugin is profile-linked)

`@deepseek-ai/dsh-app-boot` builds a package table for the installation scope and
answers bare-specifier resolution for plugin code:

* `dsh-app-boot/lib/index.js:716` `collectInstallationScopePackages()` — walks the runtime
  manifest's dependency closure, so all `@deepseek-ai/*` the app ships (`cordis`,
  `dsh-llm`, `dsh-attachment`, …) become installation-scope entries;
  `:766` `createRuntimeResolution()`, `:774` `collectProfileScopePackages()`,
  `:775` `linkedProfileRoots()`.
* `dsh-app-boot/lib/worker/profile-resolution-bootstrap.js:630` `installRuntimeInterception()`
  installs the resolver; `:121` `findInterceptionLayer()` classifies an importer path as
  profile / **linked root** / other; `:460` `routeLinked()` is the branch for code that
  lives outside `profiles/` but is linked into a profile's `node_modules`:
  for each ancestor `node_modules` search path it calls `readPeerNames()` (`:131`) on the
  declaring directory and, when the package name appears in that manifest's
  `peerDependencies`, routes the import to the installation copy; otherwise native
  resolution is kept.

Consequence: **when the profile links this directory** (the same way
`@local/dsh-companion-memory-studio` → `plugins/companion-memory-studio` is linked in
`home/profiles/desktop/package.json`), `@deepseek-ai/cordis` and `@deepseek-ai/dsh-llm`
are resolved to the runtime's own files with **no extra filesystem objects**. Because
`package.json` already declares both as peers, nothing has to be added for that case.

### 6.3 Layer B — junctions in the plugin's own `node_modules` (used otherwise)

Interception only applies to importers inside the profiles tree or inside a linked root.
If the plugin is instead mounted by absolute path (or loaded by a plain `node` process,
e.g. smoke tests), resolution falls back to Node's native lookup, which needs a
`node_modules/@deepseek-ai/*` entry. Three directory junctions provide it:

```
node_modules/@deepseek-ai/cordis          -> <runtime>\node_modules\@deepseek-ai\cordis
node_modules/@deepseek-ai/dsh-llm         -> <runtime>\node_modules\@deepseek-ai\dsh-llm
node_modules/@deepseek-ai/dsh-attachment  -> <runtime>\node_modules\@deepseek-ai\dsh-attachment
```

Junctions (not copies) are deliberate: Node resolves symlinks/junctions to their real
path (`--preserve-symlinks` is off), so the plugin gets the **same module instance** the
host uses — extending `Service` from a duplicate cordis copy would silently break plugin
lifecycle. Verified:

```
import.meta.resolve('@deepseek-ai/cordis')  -> file:///C:/Users/bobo/AppData/Local/.../app/dsh/node_modules/@deepseek-ai/cordis/lib/index.js
import.meta.resolve('@deepseek-ai/dsh-llm') -> file:///C:/Users/bobo/AppData/Local/.../app/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js
```

Trade-off accepted: the junctions embed an absolute path to the installed app. If the
Desktop app is reinstalled at a different location, re-run §4 step 3 (or delete the
junctions and rely on Layer A only).

### 6.4 `.d.ts` are *not* available from the runtime — type-checking is fed from npm

The shipped runtime packages contain **no declaration files** (`@deepseek-ai/cordis/lib`
holds only `index.js`; `dsh-llm/lib/types/*` are `.js` only). Historically a plain
`tsc -p tsconfig.json` failed here with 29 errors — 13 × TS7016
(`Could not find a declaration file for module '@deepseek-ai/cordis' / 'dsh-llm'`) plus
15 × TS2339 and 1 × TS2665 that are pure consequences of the peers collapsing to `any`
(`ChannelQQ` loses the inherited `ctx` property; cordis's global augmentations vanish).

> **Update 2026-10-29**: those 29 errors are gone — `tsc -p tsconfig.json` now exits 0.
> The `paths` mapping described below was moved **into the base `tsconfig.json`** so that
> every derived config (build / test / verify) inherits it instead of re-declaring it.

Fix, with **zero changes to upstream files**: `vendor/types/<pkg>/` holds the complete
published tarballs of the *exact runtime versions* (`cordis@4.0.5`,
`dsh-llm@0.2.1-rc.3`, `dsh-attachment@0.2.1-rc.3`, 0.73 MB total) and the base
`tsconfig.json` maps the bare specifiers onto their declaration entry points:

* `tsconfig.json` — the **single source** of the mapping:
  `paths: { "@deepseek-ai/cordis" → vendor/types/cordis/lib/types/index.d.ts, … }`
  (no `baseUrl`; TS ≥ 5 resolves `paths` relative to the config file itself);
* `tsconfig.build.json` — extends upstream `tsconfig.json` (same
  `target/module/strict/outDir/rootDir/declaration` settings, unchanged) and adds nothing;
* `tsconfig.test.build.json` — same, on top of upstream `tsconfig.test.json`;
* `tsconfig.verify.local.json` — stricter local check (adds `noEmit`) that now just inherits.

`paths` affects type resolution only; emitted specifiers stay bare (§3), so this has no
runtime effect. `dsh-attachment` is mapped because `dsh-llm`'s declarations reference it
(3 references found in `vendor/types/dsh-llm/**/*.d.ts`).

---

## 7. Verification results

| Check | Command | Result |
|---|---|---|
| Compile | `node node_modules/typescript/bin/tsc -p tsconfig.build.json` | **exit 0**, 333 `.js` + 333 `.d.ts` emitted |
| Type-check only | `… -p tsconfig.build.json --noEmit` | **exit 0** |
| Module resolution + syntax (standalone, no host) | `node --input-type=module -e "await import('file:///…/build/lib/index.js')"` | **IMPORT OK keys=ChannelQQ,default** — no `MODULE_NOT_FOUND`; the peer graph (`cordis`, `dsh-llm`, `ws`, `silk-wasm`) loads and only the class definitions are evaluated, so no cordis context is required at import time |
| Admin bundle consistency | `node scripts/build-admin-html.mjs --check` | pass — 36 modules, 282,165 bytes, matches `src/admin/ui/**` |
| Script syntax | `node scripts/check-syntax.mjs` | pass — 13 scripts parse |
| Layer gate | `node scripts/check-layers.mjs` | pass — 333 source files; host-package imports in 10 files, all within the upstream baseline. Those 10 files: `src/plugin.ts`, `src/services.ts`, `src/emoji-library.ts` and the 7 `src/adapters/dsh-host/*.ts` modules |
| Source-size ratchet | `node scripts/check-size.mjs` | pass — 332 files (1 over 400 lines), 1719 functions (1 over 60 lines); upstream `scripts/size-baseline.json` untouched |
| Test build | `node node_modules/typescript/bin/tsc -p tsconfig.test.build.json` | **exit 0**, 416 `.js` in `build/lib-test` |
| Unit tests | `node --test "build/lib-test/test/**/*.test.js"` | **657 pass / 7 fail / 1 skipped of 665** — unchanged after the §8 patches; all 7 failures explained below, none caused by the build or the patches |
| Patch P1 audit | `grep -rn "required:\s*\(true\|false\)" src/` | no matches — every `required` left in `src/` is an object-level array of field names |
| Golden snapshots | `UPDATE_GOLDEN=1 node --test build/lib-test/test/golden.test.js build/lib-test/test/tools-v2.test.js` then diff `test/golden/` against a backup | 30/30 pass with update; diff = exactly 2 lines in `tools/qq-tools.txt` (the removed `"required": true,`) |
| Upstream drift | hash-diff `src/**` + `test/**` against the snapshot (§9 snippet) | exactly 2 `src/` files + 1 `test/` file differ, all from §8 |

Note on `scripts/check-size.mjs`: despite the name it is **not** a build-size gate. It is a
source-structure ratchet (file length / function length vs `scripts/size-baseline.json`),
part of upstream's `npm run verify` CI flow, and it needs `typescript` importable from the
plugin directory. It passes unchanged; it says nothing about `build/` megabytes.

### The 7 failing tests (all pre-existing / by design of the vendoring)

1. Six failures come from the excluded `eval/` harness:
   * `test/eval-harness.test.ts` (5 failures) `spawnSync`s `node eval/run.mjs` — `eval/` was
     deliberately not vendored (§1).
   * `test/memory-retrieval.test.ts` (whole file fails) imports
     `../../../eval/memory/corpus.mjs` (`test/memory-retrieval.test.ts:24`) → `ERR_MODULE_NOT_FOUND`.
   Restoring `eval/` (it is scoring data, not runtime code) would make these 6 pass.
2. One genuine upstream test bug:
   `test/file-receive.test.ts:65` defines the fixture as `demo-1.0.0.apk` while
   `:71` asserts the saved name is `inbox/简助手-5.7.0.Apk`. The assertion cannot hold for
   the fixture, on any platform. **Not patched** — behaviour was not touched; reported instead.
3. 1 test is skipped by its own guard: `test/session-log-frames.test.ts:98` runs only when
   `SESSION_LOG_FIXTURE` points at a real DSH session log (`{ skip: fixture === '' || !existsSync(fixture) }`,
   `:96`) — such a log exists on the upstream server, not on this host. 0 todo.

The failures above are the only test noise; 657/665 pass, including
all pure-logic suites (message parsing, batching, triggers, silk handling, SSRF guard,
memory retrieval internals, admin API contracts).

---

## 8. Local patches to upstream (8 patches across 8 files)

Both patches fix upstream bugs that are invisible to the upstream test suite but fatal (or
noisy) in the real runtime. Each is a **deletion or a single guard line** — no behaviour the
plugin intends was changed. Report them upstream; drop them here once upstream ships them.

### P1 — invalid JSON Schema made every QQ turn fail with HTTP 400 (blocker)

`src/features/music/tools.ts:57` (`qq_resolve_music`) and `:179` (`qq_music_lyrics`) put
`required: true` **inside a property spec**, which is not JSON Schema: `required` is only
valid at object level, as an array of strings. The object-level `required: ['songId']` two
lines below each already expressed the intent, so the fix is deleting the stray keyword:

```diff
-            songId: { type: 'string', required: true, description: '网易云歌曲ID' },
+            songId: { type: 'string', description: '网易云歌曲ID' },
```

Evidence (verify-harness, isolated CLI harness with a live model call, 2026-10-28):

```
<testhome>/home/channel-qq.log
2026-10-28T15:38:13.563+08:00 agent error: LlmError: 400: {... "message":
  "Upstream request failed: [invalid_request_error] Invalid schema for function
   'qq_music_lyrics': true is not of type \"array\" (request_id: 7c3bc0b6-...)"}
2026-10-28T15:38:13.566+08:00 turn done for dm-1429709395
```

This is not a per-tool degradation: the provider validates the **whole** tool list, so one
bad schema rejects the request and no tool call — indeed no model step — can happen. Every
QQ turn is dead.

Audit done (the whole `src/`, not just music): the only two boolean `required` were these;
every other `required` in `src/features/**` and `src/app/**` is an object-level array of
field names (`grep -rn "required:\s*\(true\|false\)" src/` → no matches after the patch), and
`src/features/tools-v2/mapping.ts:80` builds `required: ['action']` correctly. No
`additionalProperties` is used anywhere in `src/`.

Golden snapshot: `test/golden/tools/qq-tools.txt` had pinned the invalid schema as the
expected value (2 lines). Regenerated with `UPDATE_GOLDEN=1` restricted to
`golden.test.js` + `tools-v2.test.js`; the diff versus a backup of `test/golden/` is exactly
those two `"required": true,` lines and nothing else — no unrelated snapshot drift.

### P2 — `affectionPort: 0` bound an ephemeral port instead of meaning "off"

`src/affection.ts` `serve()` had no guard, while the config help text promises `0` = closed
(`src/config/sections/root.ts:31-34` — `help: '只听本机；0 关闭。', min: 0`) and `relisten()`
already guarded (`affection.ts:253`, "0 = 关闭"). With `affectionPort: 0` the plugin still called
`server.listen(0)` → a random loopback port, logged as
`affection dashboard: http://127.0.0.1:0/?key=<random>`. Patch = 3 lines at the top of
`serve()` (a comment plus the guard), matching `relisten`'s contract:

```diff
   async serve(port: number, opts: … = {}): Promise<void> {
+    // `affectionPort: 0` 是文档承诺的"关闭"（见 config/sections/root.ts 的帮助文本）：
+    // 不监听就返回，否则 `server.listen(0)` 会真的绑一个随机回环端口。
+    if (!Number.isFinite(port) || port <= 0) return
     this.configure(opts)
```

Callers are unaffected: `src/features/affection/index.ts:17` ignores the return value and
still registers `host.provide('affection', …)`; reloads go through
`relisten()` (`index.ts:39`), which keeps working for any port > 0 (it closes the previous
listener, then re-serves). `src/affection.ts:258` (`await this.serve(port)` inside
`relisten`, whose own guard is at `:257`) now hits the guard only for ports it already
rejected. Post-patch line map: guard `affection.ts:182`, `relisten` `:253`.

### Re-applying after an upstream update

1. Re-copy sources (§4 step 1 / §10 step 1) — this reverts both patches.
2. Apply P1 and P2 again (they are the two diffs above; grep first:
   `grep -rn "required: true" src/` and `grep -n "async serve(port" src/affection.ts`).
3. Rebuild, then regenerate golden with `UPDATE_GOLDEN=1` on `golden.test.js` +
   `tools-v2.test.js` and confirm the only diff is the two `"required": true,` lines.
4. If upstream fixed either bug, delete that patch and update this section (the header
   sentence and the §9 table both count patches; keep the count honest).

---

## 9. Deviations from upstream (complete list)

`src/**/*.ts`: **331 of 333 files hash-identical** to the snapshot; the two exceptions are the
§8 patches (`src/features/music/tools.ts`, `src/affection.ts`). Everything else — `package.json`,
`tsconfig*.json`, `cordis.patch.yml`, `scripts/**`, `docs/**`, `assets/**`, `deploy/**` — untouched.
`test/**` has exactly one changed file, `test/golden/tools/qq-tools.txt` (2 lines, P1).
Generated `src/admin-html.ts` reproduces upstream's committed copy byte-for-byte
(`--check` passes). Re-verify the claim with:

```powershell
$src = '<snapshot dir>'; Compare-Object `
  (Get-ChildItem src -Recurse -File | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length+1) + ' ' + (Get-FileHash $_.FullName).Hash }) `
  (Get-ChildItem $src\src -Recurse -File | ForEach-Object { $_.FullName.Substring($src.Length+1) + ' ' + (Get-FileHash $_.FullName).Hash })
# expect exactly 2 "=>/<=" pairs: features\music\tools.ts and affection.ts
```

| # | Added / omitted | Purpose |
|---|---|---|
| 1 | **added** `tsconfig.build.json` | upstream compile config + peer `paths`; used instead of `tsc -p tsconfig.json` because the runtime ships no `.d.ts` (§6.4) |
| 2 | **added** `tsconfig.test.build.json` | same, for the optional test build (`build/lib-test`) |
| 3 | **added** `vendor/types/{cordis,dsh-llm,dsh-attachment}/` (0.73 MB) | declaration files of the exact runtime peer versions; type-check only, never imported at runtime |
| 4 | **added** `node_modules/` (pnpm prod deps + 3 junctions + copied tsc/@types) | runtime deps and toolchain (§5); git-ignored |
| 5 | **added** `pnpm-lock.yaml` | records the two prod deps installed by pnpm (`ws`, `silk-wasm`); upstream ships `package-lock.json` for its own dev flow, which is kept but unused here |
| 6 | **added** `build/` | compiled output; git-ignored upstream by design |
| 7 | **omitted** `.git`, `.github` | not part of a vendored copy |
| 8 | **omitted** `eval/` | offline scoring harness + fixtures; only affects the 6 tests in §7. Restore with `robocopy %TEMP%\qqplugin\dsh-channel-qq-main\eval eval /E` if scoring is wanted |
| 9 | **not installed** upstream devDependencies (`@deepseek-ai/cordis@4.0.5-alpha.2`, `dsh-llm@0.2.1-alpha.2`, `dsh-attachment@0.2.1-alpha.2` + their alpha closure) | version drift vs the runtime; replaced by #3. Note: contrary to expectation, a full `npm install` *does* resolve in this snapshot (`npm install --dry-run` → 18 packages, no `link:`/`EUNSUPPORTEDPROTOCOL` issue; `package-lock.json` contains no `link:` entries). It is rejected because those alpha `@deepseek-ai/*` copies would sit in this `node_modules` and shadow the runtime's modules whenever interception does not apply (§6.3), i.e. a second `cordis` instance — the one failure mode that breaks cordis plugin lifecycle. `pnpm --prod` installs only `ws` + `silk-wasm` |
| 10 | **patched** `src/features/music/tools.ts` (2 deletions) | P1: invalid property-level `required: true` rejected by the provider (§8) |
| 11 | **patched** `src/affection.ts` (+3 lines) | P2: `affectionPort: 0` must mean "no listener" (§8) |
| 12 | **patched** `test/golden/tools/qq-tools.txt` (2 lines) | P1's snapshot regeneration — the snapshot had pinned the invalid schema |

Because of #1–#2, upstream's own npm scripts behave as follows in this directory:

* `npm run build` / `npm run typecheck` → use `tsconfig.json` → 29 errors (§6.4). Use
  `node scripts/build-admin-html.mjs && tsc -p tsconfig.build.json` instead.
* `npm run test` → `typecheck:tests` uses `tsconfig.test.json` (same failure); use
  `tsc -p tsconfig.test.build.json && node --test "build/lib-test/test/**/*.test.js"`.
* `npm run check:admin` / `check:syntax` / `check:layers` / `check:size` → pass as-is
  (they need `node_modules/typescript` for `check:size`, present).

---

## 10. Rebuild after an upstream update

```powershell
$src  = '<new snapshot dir>'          # extracted tarball of the new upstream main
$plug = 'C:\Users\bobo\Documents\Bot\dsh-companion\plugins\dsh-channel-qq'

# 1. refresh sources only (keep node_modules / vendor / pnpm-lock.yaml / tsconfig.build*.json)
robocopy $src $plug /E /XD .git .github node_modules eval build vendor /NFL /NDL /NJH /NJS /NP

cd $plug
# 2. if upstream changed its dependencies: re-install runtime deps, then re-create the
#    3 junctions and re-copy the toolchain (@types/node, @types/ws, undici-types, typescript)
pnpm install --prod --ignore-scripts --config.auto-install-peers=false
# ... re-run §4 steps 3 and 4 (idempotent) ...

# 3. if upstream bumped a peer version: re-vendor declarations for the version the
#    RUNTIME ships (check <runtime>\node_modules\@deepseek-ai\<pkg>\package.json first)
#    → §4 step 5 with the new version numbers

# 4. build + verify. NOTE: step 1 reverted the §8 patches — re-apply P1/P2 first,
#    otherwise the rebuilt plugin is the broken build again.
node scripts/build-admin-html.mjs
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node scripts/build-admin-html.mjs --check
node scripts/check-syntax.mjs ; node scripts/check-layers.mjs ; node scripts/check-size.mjs
node --input-type=module -e "await import('file:///C:/Users/bobo/Documents/Bot/dsh-companion/plugins/dsh-channel-qq/build/lib/index.js').then(m=>console.log('IMPORT OK',Object.keys(m)))"
```

If the new upstream commit changes `src/`, re-check whether `tsconfig.build.json` still
inherits cleanly (it only adds `paths`) and whether the peer surface (`grep` for
`@deepseek-ai/` under `src/`) grew beyond `cordis` + `dsh-llm`; a new peer means either
declaring it in `package.json` peerDependencies (so Layer A intercepts it) or another
junction + `paths` entry.

---

## 11. Open risks / limitations

1. **Junctions pin an absolute path** to the installed Desktop app. App reinstall at a
   new path → stale junctions (`MODULE_NOT_FOUND` in standalone use). Layer A keeps
   working for profile-linked mounts; re-run §4 step 3 otherwise.
2. **Type-check fidelity**: declarations come from the *published* `4.0.5` /
   `0.2.1-rc.3` packages, i.e. the same version strings the runtime reports, but the
   runtime's own files are built/stripped artefacts. A hidden API difference would show
   up at load time, not at compile time. Load-time smoke test of the plugin inside a
   real profile is the remaining gate (owned by the profile/Lead side; not performed here
   because `home/profiles/desktop/**` is out of scope for this task).
3. **The plugin is not yet wired into a profile.** Nothing in this directory registers
   itself; `cordis.patch.yml` inserts one row `channel-qq` (`name: dsh-channel-qq`,
   config defaults: OneBot forward WS `ws://127.0.0.1:3001`, `selfId: 10000`,
   `requireMention: true`, admin panel on, skills under `<dshHome>/channel-qq/skills`).
   The profile needs `"dsh-channel-qq": "link:…/plugins/dsh-channel-qq"` (or a
   `@local/…` alias) plus that bundle patch.
4. **`pnpm install` pruning**: manual `node_modules` additions are outside pnpm's
   lockfile; a future `pnpm install` may remove `@types/*`, `typescript`,
   `undici-types` and the junctions. Re-run §4 steps 3–4 afterwards.
5. **Test suite is not green by construction**: 7 known failures (§7) — 6 need the
   excluded `eval/`, 1 is an upstream assertion bug. Do not treat `node --test` as a
   release gate for the vendored tree without that context.
6. `deploy/` is vendored for ops reference only; nothing here runs it, and its
   `.ssh-env`-dependent scripts are inert without credentials.

### 11.1 Runtime defaults worth knowing before wiring a profile

Surfaced by verify-harness while running the plugin for real; all three are **upstream
behaviour, not build defects**, and none is patched here (documented instead):

* **Two loopback listeners start by default.** `admin.enabled` defaults to `true` with
  `port: 8790` (`src/config/sections/system.ts:24-25`) and `affectionPort` defaults to
  `8789` (`src/config/sections/root.ts:31-34`). So a freshly wired profile opens **8789 +
  8790** on `127.0.0.1` (admin additionally requires a password hash / env secret to be
  usable). To run quiet: `admin: { enabled: false }` and `affectionPort: 0` — the latter is
  now genuinely silent thanks to patch P2 in §8.
* **`proactive.v2: false` (the default) still starts the legacy scheduler.** The two
  implementations are selected at assembly time (`src/features/proactive/index.ts:44-46`);
  with v2 off the plugin runs `Scheduler` (`src/features/proactive/events.ts:62`), whose
  fixed timetable (`patrol` every 9 min ±1, `dm-proactive` every 22 min ±1.5, dream
  04:xx, knowledge extraction, evolve 6 h, task-book jobs) logs
  `scheduler started: …` at boot (`events.ts:89`). "v2 off" means *old behaviour*, not
  *silence*; if a deployment wants no proactive traffic at all, that needs a config/schema
  change upstream (there is no top-level proactive off switch today).
* **`tools.v2` and `proactive.v2` are independent.** With `tools.v2: true` and
  `proactive.v2: false` the legacy scheduler may reference tools the merged tool surface no
  longer exposes — upstream notes this itself at `src/features/proactive/events.ts:223`.
  Not exercised here; keep the two switches consistent when wiring.

### Patch 3 — `src/core/text/segment.ts` `segmentText()` (added 2026-10-28 19:40)

**Why.** Upstream only treats sentence-ending punctuation (`。！？…`) as a boundary. 三月七's
persona writes one clause per line with no trailing period, and a real QQ reply showed the
consequence — the whole two-line answer went out as **one** message (`messageId 682632582`):

```
在的在的
怎么了，这么晚才想起来找我
```

The owner's report was "没有分段回复".

**Change.** When `style === 'active'`, split the body on newlines first (one line = one unit),
then run each unit through the unchanged `splitByEnders`. `natural` / `conservative` still take
the original path (`units` has a single element), so their output is byte-identical to upstream.
`active` is documented in the schema as "每句一条", so counting a newline as a sentence boundary
is consistent with that style's own contract.

**Verification (built `build/lib`, no host needed).**

```js
segmentText('在的在的\n怎么了，这么晚才想起来找我', { enabled:true, style:'natural', ... })
// -> ['在的在的\n怎么了，这么晚才想起来找我']       (unchanged)
segmentText(same, { style:'active' })
// -> ['在的在的', '怎么了，这么晚才想起来找我']
```

**Deployment side.** `home/profiles/desktop/cordis.patch.yml` →
`channel-qq.config.segmentation = {enabled: true, style: active, minLength: 8, maxSegments: 8,
removeTrailingPeriod: true}`. The profile previously omitted the section, which meant the bundle
default `style: natural`.

**Re-apply after an upstream update.** Restore upstream's `segmentText()` and re-apply the newline
split; when `style` is not `active` the patch has no effect, so it is inert by default.

### Patch 4 — `src/core/message/render.ts` `renderMessageLine()` (added 2026-10-30 02:50)

**Why.** The owner asked for 年月日 in the message prompt. Upstream renders the message line with a
bare `HH:MM` (`src/core/message/render.ts:54`, documented as a deliberate choice at `:14`). With a
companion that runs for days, a time without a date lets the model conflate "昨天说的" with
"刚才说的" — there is no other date anchor in the DM packet (`packet/time.txt` only carries
`（当前时段：{{period}}）`).

**Change.** One extra local `stamp` built from the same `Date`:

```ts
const stamp = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2,'0')}-${String(time.getDate()).padStart(2,'0')} ${hhmm}`
```

and the line prefix uses `stamp` instead of `hhmm`. Everything else in the line is untouched.

**Verification (built `build/lib`):**

```js
renderMessageLine({ event: { time: 1793316000, message_id: 123456, user_id: 1429709395, sender: { nickname: '槑' } }, … })
// -> '2026-10-30 07:20 槑(1429709395) #123456 [@咱]：在吗'
```

**Known consequence.** `test/golden/{dm-text,group-*}.txt` pin the old `HH:MM` prefix, so the upstream
golden test fails until the snapshots are regenerated — expected for a deliberate format change, and
why this is recorded here instead of silently updating them.

**Re-apply after an upstream update.** Re-introduce the `stamp` line; without it the line keeps
upstream's `HH:MM`.

### Patch 5 — segment pacing: `src/features/messaging/tools.ts` + `src/config/sections/chat.ts` (added 2026-10-30 03:05)

**Why.** With `segmentation.style: active` a reply is sent as several OneBot messages, and upstream
only spaces them by the flat global `rateLimitMs` (300 ms) — the segments land almost simultaneously.
The owner asked for a pause between segments that grows with the length of the sentence.

**Change.**
- New helper `pauseBetweenSegments(piece, index, total, segmentation)` next to the other helpers in
  `features/messaging/tools.ts`; it is awaited **after each segment except the last** in the
  `qq_send_text` loop (the only place that iterates `segmentText()` output).
- Pause = `clamp(len(just-sent piece) × delayPerCharMs, delayMinMs, delayMaxMs)`; `delayPerCharMs <= 0`
  disables it entirely (upstream behaviour).
- Three new fields on the `segmentation` section (`src/config/sections/chat.ts`, defaults
  `delayPerCharMs: 60`, `delayMinMs: 200`, `delayMaxMs: 3000`) plus their types in
  `src/config.ts`'s `SegmentationConfig`. They are appended at the end of the group so the resolved
  config's key order is preserved except for the new trailing keys.

**Verification (built `build/lib`, no host needed).**

```
resolveConfig({}, {}).segmentation
// -> {enabled:false, style:'natural', minLength:8, maxSegments:8, removeTrailingPeriod:true,
//     delayPerCharMs:60, delayMinMs:200, delayMaxMs:3000}
4 字 -> 240ms · 10 字 -> 600ms · 20 字 -> 1200ms · 60 字 -> 3000ms (capped)
```

**Deployment side.** `home/profiles/desktop/cordis.patch.yml` → `channel-qq.config.segmentation`
now spells the three knobs out explicitly (they would otherwise come from the schema defaults).

**Re-apply after an upstream update.** Re-add the helper, the one `await` in the send loop, and the
three schema fields; with `delayPerCharMs: 0` the behaviour is exactly upstream's.

### Patch 6 — guidance injection during a running turn (`dm-buffer.ts` / `turns.ts` / `turn-tracker.ts`, added 2026-10-30 18:10)

**Why.** Upstream's DM buffer refuses to deliver while a turn is busy (`DmBuffer.flush` re-schedules
every 500 ms and keeps the lines queued), so anything the user types **while she is still replying** —
including during the segment pauses added by Patch 5 — only reaches her as a *new* turn after the
current one ends. The owner asked for those messages to become guidance **inside the running turn**.

**Change.**
- `turn-tracker.ts`: new `injectGuidance(content)` — forces the `inject` channel while
  `session.isRunning()`, ignoring `injectMode`; returns `false` when the turn is idle or the host
  rejects the channel (caller then falls back to queueing).
- `turns.ts`: new `injectGuidance(conversation, prompt)` wrapping it, with a `guidance injected into
  running turn for <room>` log line. It deliberately does **not** re-send the runtime note or call
  `begin()`.
- `dm-buffer.ts` `flush()`: before the old "busy ⇒ re-schedule" branch, if the turn is
  `running()` and there are queued lines, compose the inject packet and try `injectGuidance()`;
  on refusal the lines are put back and the normal schedule resumes.

**Verification.** `tsc -p tsconfig.build.json` → exit 0. Runtime proof needs two real messages inside
one turn (see `workspace/TASK_PROGRESS.md` §13); the log line above is the observable.

**Re-apply after an upstream update.** Re-add the three pieces; without them the behaviour is exactly
upstream's (new turn after the current one finishes).

### Patch 7 — typing indicator: serialise the protocol actions + watchdog (`src/features/interaction/index.ts`, added 2026-10-31 00:20)

**Why.** Turning `interaction.typingIndicator` on produced a stuck "对方正在说话" in QQ: upstream fires
every `set_input_status` as an independent request (`call()` → fire-and-forget), so the `1` from a new
`begin()` and the `0` from an immediately preceding `end()` (retry, session re-cycle, next turn) can
arrive in either order — and when the `1` lands last the indicator stays on forever. `set_input_status`
itself is supported (probed directly against NapCat 4.18.19: `retcode 0` for both `event_type` 1 and 0).

**Change.**
- `queue(room, what, run)` replaces the fire-and-forget `call()`: all input-status/reaction actions are
  chained on one promise, so the last action always reflects the latest state. Successes are logged too
  (`interaction input status on ok for <room>`), which is what made the missing `end()` visible.
- Per-room watchdog: `TYPING_MAX_MS = 120_000`; when the typing hint is armed the plugin schedules an
  unconditional `event_type: 0` (logged as `正在输入超过 120s，自动撤销`). Lost idles, session
  re-cycles and host restarts can no longer leave the hint hanging.
- `dispose()` clears every active hint; wired via the `apply()` return value.
- **Deployment side:** `interaction.typingIndicator` is back to `false` in the profile until this is
  verified on a live turn (the placeholder message rule in `workspace/AGENTS.md` already gives the user
  a visible reply before slow media tools).

**Verification.** `tsc -p tsconfig.build.json` → exit 0; `set_input_status` on/off confirmed against the
real NapCat endpoint. Live re-enable is still pending.

**Re-apply after an upstream update.** Keep the serialisation and the watchdog; with
`typingIndicator: false` nothing is sent at all and the patch is inert.

### Patch 8 — send latency: admin short-circuit + background tail (`src/features/messaging/tools.ts`, added 2026-10-31 15:00)

**Why (measured).** Owner DMs took 27–33 s per `qq_message`. Splitting the tool duration with the
session log + `sent-dm-*.json` + NapCat's own log showed where it went:

| turn | tool total | until first send | first→last | last→return |
| --- | --- | --- | --- | --- |
| 114 | 33241 ms | **24432 ms** | 8800 ms | 9 ms |
| 118 | 31498 ms | **24570 ms** | 6925 ms | 3 ms |
| 119 | 27140 ms | **23835 ms** | 3302 ms | 3 ms |

NapCat received the owner's message at 11:55:10 and the first reply frame left at 11:55:47. The
"first→last" part is Patch 5's pacing (intended); the ~24 s before it is `assertWindowReachable()`
calling `api.getFriendList()` *unconditionally for private chats* — an 8 s-timeout call that can also
sit in `onebot.call()`'s 12 s reconnect grace. For a DM to the admin that lookup adds nothing: the
admin check in `assertTargetAllowed()` is the real gate.

**Change.**
1. `assertWindowReachable()`: if the target is in `config.admins`, return immediately — no friend-list
   round trip. Non-admin DMs still verify membership, now through a 5-minute `friendListHas()` cache.
2. `qq_send_text` sends **only the first segment synchronously** and hands the rest to a detached
   sequential task that keeps Patch 5's pauses. The `out` queue is process-wide and strictly serial,
   so later tool sends (sticker / voice) still land after those tail segments; a tail failure is logged
   (`tail send failed: …`) and does not touch the already-returned result. The tool now returns
   `{ message_id, segments, queued }`.

**Verification.** `tsc -p tsconfig.build.json` → exit 0. Expected effect: tool time ≈ one send
(~300 ms + RTT) instead of 27–33 s; the remaining segments still arrive with the configured pauses.
Runtime numbers pending the next restart.

**Re-apply after an upstream update.** Restore the single `for (const piece of pieces)` loop and drop
the admin short-circuit; both changes are additive and independent of patches 3/5/6/7.

### Patch 10 — sticker steal: trust the bytes, not the URL suffix (src/emoji.ts, added 2026-11-01 23:05)

**Why.** EmojiStore.steal() derived the file extension from the image URL and fell back to .png.
QQ's animated stickers are frequently served from an extension-less URL, so a **GIF** landed on disk as
stolen_*.png; reading it later failed with 	he .png extension declares image/png, but the bytes use a
different image format.

**Change.** New sniffImageExtension(buf) (PNG / JPEG / GIF / WebP / BMP magic numbers) and the stolen
file is written as stolen_<ts>_<rand><realExt>; the URL suffix is only a fallback when the bytes are
unrecognised.

**Repair done on 2026-11-01.** home/channel-qq/emoji/stolen_1793544973577_d26a70d8.png → .gif
(real format confirmed by magic bytes), and all three emoji-index.json paths normalised to absolute
paths that exist; re-verified format-vs-extension for every entry.

**Verification.** 	sc -p tsconfig.build.json → exit 0; the built sniffImageExtension() correctly
reports .gif for the previously mislabelled file.

**Re-apply after an upstream update.** Restore upstream's ext-only naming and drop the helper.

### Patch 11 — private "typing" + read reaction (src/features/interaction/index.ts, added 2026-11-03)

**Why.** The owner asked for the QQ typing hint and a "read" reaction. Both exist upstream but were
narrowed: 	ypingIndicator only does private chats (fine) and ckReaction was **group-only** because
SnowLuma answered private reactions with retcode 100 (comment dated 2026-10-22). Against NapCat 4.18.19
the action works for private messages — direct probe returned etcode: 0.

**Change.**
1. Drop the isGroup requirement from ckReaction, so DMs get the reaction too.
2. queue() now inspects the OneBot ack's **inner** status: etcode: 0 but data.result != 0 is a QQ
   side failure (observed: 65011 操作失败 for an old message, 65009 操作频繁 when hammering). Those
   are logged as interaction <what> rejected for <room>: <errMsg> (result=<n>) instead of being
   silently treated as success.

**Config.** home/profiles/desktop/cordis.patch.yml → interaction: { typingIndicator: true,
ackReaction: true, ackEmojiId: '424' } (424 = QQ's "thinking" face, used as the read marker).

**Verification.** 	sc -p tsconfig.build.json → exit 0; built interaction/index.js no longer contains
ckReaction && isGroup; check-qq-profile.mjs → ok=true. Runtime confirmation (typing visible, and
whether QQ accepts the reaction from the *fresh* message) still pending a live message.

**Caveat.** QQ may reject reactions on messages that are old or already reacted; the ejected log line
is the signal. If private reactions stay rejected, set ckReaction: false and keep only typing.

### Patch 12 — session rotation must not brick the room (src/features/session-reset/index.ts, added 2026-11-04)

**Why.** The token watchdog rotated the QQ DM session at 02:26:44 (231945/262144 tokens ≈ 88% > 85%) by
s.rename-ing the whole session directory into channel-qq/backups/. Two things then went wrong:

1. the original path was never recreated, so the next turn's open …/qq-dm-1429709395/session.v4.jsonl.zstd
   failed with ENOENT and the desktop UI showed 本轮运行失败;
2. the probe kept reading the **stale** 231945-token estimate (the host still had the old session record),
   so at 02:31:44 it rotated again — this time moving the (empty) directory away a second time.

**Change.**
- After s.rename(dir, backup) the original directory is recreated (s.mkdir(dir, {recursive:true})), so
  the next append lands in a fresh file instead of ENOENT.
- Rotation cooldown: if the room was reset within the last 30 minutes, the watchdog skips it and logs
  刚换过血（<30 分钟），跳过重复换血. Stale estimates can no longer eat the directory repeatedly.

**Recovery applied by hand (2026-11-04 02:35).** The old history is intact in
home/channel-qq/backups/session-auto-2026-11-04T02-26-44-847+08-00-qq-dm-1429709395/session.v4.jsonl.zstd
(3.6 MB); the session directory was recreated empty so the room can build a new session after the restart.

**Verification.** 	sc -p tsconfig.build.json → exit 0. Live check after restart: log should show
	urn done with no gent error: … ENOENT, and session-reset: 探测 … lines without a new rotation.

**Re-apply after an upstream update.** Keep the mkdir-after-rename and the cooldown; both are additive.

### Patch 6 amendment — mid-turn interjection gets its own switch (2026-11-04)

Patch 6 (guidance injected into the *running* turn) was gated behind injectMode.enabled on 2026-10-31
while hunting the "turn ends right after the ack" bug. That bug turned out to predate the patch
(41/56 truncated turns before it landed), but the gate stayed — so from 2026-11-01 the feature was
dead: guidance injected appears only 6 times, all on 10-30/10-31.

- New field injectMode.duringTurn (src/config/sections/chat.ts + InjectModeConfig, widened in
  egistry.ts / 	urn-tracker.ts / pipeline.ts), default alse.
- DmBuffer.flush() now gates the guidance branch on duringTurn instead of nabled;
  nabled keeps its upstream meaning ("every message bypasses batching").
- Profile: injectMode: { enabled: false, duringTurn: true, wakeIdle: true }.

**Verification.** 	sc -p tsconfig.build.json → exit 0; resolved config prints
{enabled:false, duringTurn:true, wakeIdle:true}; check-qq-profile.mjs asserts both flags → ok=true.
Live check after restart: send a second message while she is still replying — the log should show
guidance injected into running turn for dm-1429709395 and **no** extra session … ready turn.
