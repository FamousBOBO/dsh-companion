import test from "node:test";
import assert from "node:assert/strict";
import {hostTempRoot} from "./host-temp.mjs";
test("Windows host temp ignores inherited workspace TEMP",()=>{
 const root=hostTempRoot({platform:"win32",env:{LOCALAPPDATA:"C:/Users/test/AppData/Local",TEMP:"C:/repo/data/tmp"}});
 assert.equal(root.replaceAll(String.fromCharCode(92),"/"),"C:/Users/test/AppData/Local/Temp/dsh-companion-host");
});
test("Windows host refuses missing local directory",()=>{
 assert.throws(()=>hostTempRoot({platform:"win32",env:{}}),/LOCALAPPDATA/);
});
