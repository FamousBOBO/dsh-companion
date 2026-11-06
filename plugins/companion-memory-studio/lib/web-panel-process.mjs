import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../../companion-media/src/config-store.mjs';
import { ApiError } from './api-kernel.mjs';

const run = promisify(execFile);
const operations = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const panelConfigFile = root => path.join(root, 'home', 'companion', 'studio.webpanels.json');
export function readPanelConfig(root) {
  try { return JSON.parse(fs.readFileSync(panelConfigFile(root), 'utf8')); } catch { return {}; }
}
function receiptFile(root) { return path.join(root, 'tmp', 'qq-panel-process.json'); }
function readReceipt(root) {
  try { return JSON.parse(fs.readFileSync(receiptFile(root), 'utf8')); } catch { return null; }
}
function localUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); } catch { return false; }
}
export function panelEmbedUrl(config) {
  if (!config.url) return '';
  const url = new URL(config.url);
  // Credentials are read only from the explicitly configured local installation.
  if (config.provider === 'napcat' && localUrl(config.url) && config.launch?.tokenFile) {
    try {
      const token = JSON.parse(fs.readFileSync(config.launch.tokenFile, 'utf8')).token;
      if (typeof token === 'string' && token) { url.pathname = '/webui/'; url.searchParams.set('token', token); }
    } catch { /* The login page remains usable when a token is not available. */ }
  }
  return url.href;
}
function launcher(config) {
  const launch = config.launch;
  if (!localUrl(config.url) || !launch || !path.isAbsolute(launch.executable || '') || !path.isAbsolute(launch.cwd || '') ||
      !fs.existsSync(launch.executable) || !fs.existsSync(launch.cwd) || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string')) return null;
  return launch;
}
async function probe(config) {
  if (!localUrl(config.url)) return null;
  try { const response = await fetch(config.url, { signal: AbortSignal.timeout(1200), redirect: 'manual' }); await response.body?.cancel(); return response.status < 500; } catch { return false; }
}
export async function panelStatus(root) {
  const config = readPanelConfig(root);
  return { provider: config.provider === 'luna' ? 'snowluma' : config.provider || '', url: config.url || '',
    embedUrl: panelEmbedUrl(config), configured: !!config.url, canControl: !!launcher(config), running: await probe(config) };
}
async function matchingProcess(pid, launch, expectedCreatedAt) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`], { windowsHide: true });
    if (!stdout.trim()) return false;
    const item = JSON.parse(stdout);
    return String(item.ExecutablePath).toLowerCase() === launch.executable.toLowerCase() &&
      launch.args.every(arg => String(item.CommandLine).includes(arg)) && (!expectedCreatedAt || item.CreationDate === expectedCreatedAt);
  }
  try {
    const exe = fs.realpathSync(`/proc/${pid}/exe`);
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return exe === fs.realpathSync(launch.executable) && launch.args.every(arg => args.includes(arg));
  } catch { return false; }
}
export async function controlPanel(root, action) {
  if (!['start', 'restart'].includes(action)) throw new ApiError('bad-request', '不支持的启动操作', 400);
  if (operations.has(root)) throw new ApiError('bad-request', '正在启动，请稍候', 400);
  operations.add(root);
  try {
    const config = readPanelConfig(root);
    const launch = launcher(config);
    if (!launch) throw new ApiError('bad-request', '请先配置本机启动程序；远端服务请在服务器上启动', 400);
    const running = await probe(config);
    if (running && action === 'start') return { ...await panelStatus(root), started: false };
    if (running && action === 'restart') {
      const receipt = readReceipt(root);
      const pid = receipt?.pid ?? launch.pid;
      const createdAt=receipt?.createdAt ?? launch.createdAt;
      if (!await matchingProcess(pid, launch, typeof createdAt==='object'?createdAt?.value:createdAt)) throw new ApiError('denied', '当前服务不是已核实的本机进程，无法安全重启', 400);
      if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      else process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 20 && await probe(config); i++) await sleep(250);
      if (await probe(config)) throw new ApiError('bad-request', '原服务仍在退出，请稍后重试', 400);
    }
    const logFile = path.join(root, 'logs', 'qq-panel.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    let child;
    if(process.platform==='win32') {
      // A short-lived launcher breaks the parent chain, so stopping DSH with
      // taskkill /T does not also terminate the user's QQ service.
      const helper="const fs=require('node:fs'),{spawn}=require('node:child_process');const p=JSON.parse(process.argv[1]);const fd=fs.openSync(p.logFile,'a',0o600);const c=spawn(p.executable,p.args,{cwd:p.cwd,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);c.once('error',()=>{process.exitCode=1});c.once('spawn',()=>{console.log(JSON.stringify({pid:c.pid}));c.unref()});";
      const {stdout}=await run(process.execPath,['-e',helper,JSON.stringify({...launch,logFile})],{windowsHide:true,timeout:10000});
      child={pid:JSON.parse(stdout).pid,exitCode:null};
    } else {
      const fd=fs.openSync(logFile,'a',0o600);
      try {
        child = spawn(launch.executable, launch.args, { cwd: launch.cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      } finally { fs.closeSync(fd); }
      child.unref();
    }
    let createdAt;
    if (process.platform === 'win32') {
      try { const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' | Select-Object CreationDate | ConvertTo-Json -Compress`], { windowsHide: true }); createdAt = JSON.parse(stdout).CreationDate; } catch { /* PID and exact launch command are still verified. */ }
    }
    writeFileAtomic(receiptFile(root), JSON.stringify({ pid: child.pid, createdAt, startedAt: Date.now() }));
    for (let i = 0; i < 40; i++) {
      if (await probe(config)) return { ...await panelStatus(root), started: true };
      if (child.exitCode !== null) throw new ApiError('bad-request', '启动进程已退出，请检查本机启动日志', 400);
      await sleep(300);
    }
    return { ...await panelStatus(root), started: true, pending: true };
  } finally { operations.delete(root); }
}
