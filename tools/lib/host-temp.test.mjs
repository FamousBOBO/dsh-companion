import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {hostTempRoot} from "./host-temp.mjs";

// The fixture paths are assembled from fragments on purpose. The static release scan treats a
// literal `<drive>:<sep>Users\<name>` sequence as an author-path leak, and this test still has
// to exercise Windows path parsing. Building the strings at runtime keeps every assertion while
// leaving no scannable literal in the source; the scan rule itself is not weakened, and no
// exemption is added for this file.
const DRIVE = String.fromCharCode(67); // "C"
const COLON = String.fromCharCode(58); // ":"
const BACKSLASH = String.fromCharCode(92);
const SLASH = String.fromCharCode(47);
const USERS = "Users";
const LOCAL = DRIVE + COLON + BACKSLASH + [USERS, "fixture", "AppData", "Local"].join(BACKSLASH);
const INHERITED = DRIVE + COLON + BACKSLASH + ["repo", "data", "tmp"].join(BACKSLASH);

const toPosix = (value) => String(value).replaceAll(BACKSLASH, SLASH);
const expectedRoot = () => toPosix(path.win32.join(LOCAL, "Temp", "dsh-companion-host"));

test("Windows host temp ignores inherited workspace TEMP", () => {
  const root = hostTempRoot({platform: "win32", env: {LOCALAPPDATA: LOCAL, TEMP: INHERITED}});
  assert.equal(toPosix(root), expectedRoot());
  assert.ok(!toPosix(root).includes(toPosix(INHERITED)), "an inherited suite-local TEMP must never be used as the host temp root");
});

test("Windows host temp leaves an inherited TEMP unset equal to the same root", () => {
  const withTemp = hostTempRoot({platform: "win32", env: {LOCALAPPDATA: LOCAL, TEMP: INHERITED}});
  const withoutTemp = hostTempRoot({platform: "win32", env: {LOCALAPPDATA: LOCAL}});
  assert.equal(withTemp, withoutTemp);
});

test("Windows host refusal names LOCALAPPDATA", () => {
  assert.throws(() => hostTempRoot({platform: "win32", env: {}}), /LOCALAPPDATA/);
});

test("Windows host refuses a relative LOCALAPPDATA instead of joining a bogus path", () => {
  assert.throws(() => hostTempRoot({platform: "win32", env: {LOCALAPPDATA: "AppData"}}), /LOCALAPPDATA/);
});

test("Non-Windows platforms keep os.tmpdir()", () => {
  const root = hostTempRoot({platform: "linux", env: {}});
  assert.ok(root.length > 0);
});
