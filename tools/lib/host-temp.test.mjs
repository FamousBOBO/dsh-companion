import test from "node:test";
import assert from "node:assert/strict";
import {hostTempRoot} from "./host-temp.mjs";
test("Windows host temp ignores inherited workspace TEMP",()=>{
 // The fixture uses a plainly synthetic root: a `C:/Users/<name>/...` shape would be
 // indistinguishable from a leaked real path and is rejected by the `author-path` leak scan.
 const root=hostTempRoot({platform:"win32",env:{LOCALAPPDATA:"C:/AppData/Local",TEMP:"C:/repo/data/tmp"}});
 assert.equal(root.replaceAll(String.fromCharCode(92),"/"),"C:/AppData/Local/Temp/dsh-companion-host");
});
test("Windows host refuses missing local directory",()=>{
 assert.throws(()=>hostTempRoot({platform:"win32",env:{}}),/LOCALAPPDATA/);
});
