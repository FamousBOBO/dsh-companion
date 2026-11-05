import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * M5 clone-style verification, runnable by any operator:
 *
 *   node scripts/verify-m5.mjs            # 在一个临时目录里跑完整流程
 *   node scripts/verify-m5.mjs --keep     # 保留临时目录（排查用）
 *
 * 它做的是"新机器上照着 README 走一遍"能做的全部离线动作：
 *   copy → npm install → npm run build → node --test
 *   → 从 config.example.json 初始化 → 配置一个 provider → 保存并确认掩码
 *   → 连接测试（mock，不产生费用）→ 一次合成内容生图（mock）
 *   → 重新挂载确认配置仍在 → 扫描密钥/本机路径
 *
 * 真实的 API 调用**不在**这里做：那需要操作者的密钥与额度，见 docs/media/M5-report.md。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const keep = process.argv.includes('--keep');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function run(command, args, cwd) {
  // Windows 上 npm 是 .cmd 批处理，必须经由 shell 才能启动；因此把参数拼成一条
  // 命令字符串并自行加引号（临时路径里可能有空格）。
  const quote = value => (/[\s"]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value));
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  const line = [executable, ...args].map(quote).join(' ');
  const result = spawnSync(line, { cwd, stdio: 'inherit', shell: true });
  return result.status === 0;
}

/**
 * 仓库卫生扫描。
 *
 * 它不是"字面上没有任何像密钥的字符串"——测试与文档里必然有**占位**密钥，
 * 否则无法验证脱敏逻辑。它扫的是：
 *   - 看起来是真的凭据（且没有 test/example/fake/verify 之类占位标记）；
 *   - 作者机器的绝对路径（测试里作为"旧配置输入"的通用示例路径除外）；
 *   - 任何二进制媒体文件（合成图只在测试运行时生成，不入库）。
 */
const PLACEHOLDER = /test|example|fake|dummy|verify|placeholder|sample|0123456789|abcdefghij|0123456789abcdef/i;
const SECRET_SHAPE = /\b(sk-[A-Za-z0-9_-]{20,}|pst-[A-Za-z0-9_-]{20,}|fish_[A-Za-z0-9]{20,})\b/g;
const AUTHOR_PATH = /(C:[\\/]+Users[\\/]+(?!someone)|D:[\\/]+Bot|AppData[\\/]+Local[\\/]+Programs)/i;

function scanTree(dir) {
  const offenders = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'data', '.git'].includes(entry.name)) continue;
        walk(full);
        continue;
      }
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (!/\.(mjs|js|json|md|yml|yaml)$/.test(entry.name)) {
        if (/\.(png|jpe?g|webp|gif|wav|mp3|ogg|flac)$/i.test(entry.name)) offenders.push(`${rel}: 二进制媒体文件`);
        continue;
      }
      const text = fs.readFileSync(full, 'utf8');
      for (const match of text.match(SECRET_SHAPE) ?? []) {
        if (!PLACEHOLDER.test(match)) offenders.push(`${rel}: 疑似真实密钥（${match.slice(0, 6)}…）`);
      }
      // 测试夹具里允许出现"旧配置样例"的合成路径（`C:/fixtures/…` 这类），源码与文档
      // 不允许出现作者机器路径。
      if (!rel.startsWith('test/') && AUTHOR_PATH.test(text)) offenders.push(`${rel}: 作者机器绝对路径`);
    }
  };
  walk(dir);
  return offenders;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-media-m5-'));
  const target = path.join(root, 'plugins', 'companion-media');
  const dataDir = path.join(root, 'data');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(PLUGIN_DIR, target, { recursive: true });
    record('复制源码到干净目录', fs.existsSync(path.join(target, 'index.mjs')), target);

    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'companion-media-m5-verify', private: true, version: '0.0.0', workspaces: ['plugins/*'] }, null, 2)}\n`,
      'utf8',
    );
    record('npm install（无依赖包，离线可完成）', run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], root));
    record('npm run build', run('npm', ['run', 'build', '--silent'], target));
    record('node --test（93 个断言）', run('node', ['--test', 'test/*.test.mjs'], target));

    // 从模板初始化：模板必须能直接当配置用
    const example = JSON.parse(fs.readFileSync(path.join(target, 'config.example.json'), 'utf8'));
    const storeDir = path.join(dataDir, 'media');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'config.json'), `${JSON.stringify(example, null, 2)}\n`, 'utf8');
    record('从 config.example.json 初始化本机配置', fs.existsSync(path.join(storeDir, 'config.json')));

    // 用真实插件入口挂载（假宿主 + mock fetch：不产生任何真实请求）
    const plugin = await import(pathToFileURL(path.join(target, 'index.mjs')).href);
    const helpers = await import(pathToFileURL(path.join(target, 'test', 'helpers.mjs')).href);
    const png = helpers.makePng({ width: 1024, height: 1024 });
    const mock = helpers.mockFetch([
      { match: url => String(url).endsWith('/models'), response: { status: 200, json: { data: [{ id: 'gpt-image-test' }] } } },
      { match: url => String(url).endsWith('/images/generations'), response: { status: 200, json: { data: [{ b64_json: png.toString('base64') }] } } },
    ]);
    const tools = [];
    const ctx = {
      tools: { register: tool => tools.push(tool.name) },
      get: () => null, // 没有 Connection：HTTP API 应当优雅跳过
      provide: () => {},
      effect: runner => runner(),
    };
    const service = plugin.apply(ctx, { dataDir, fetchImpl: mock.fetchImpl });
    record('插件在无配置/无 Connection 的宿主里加载', Boolean(service) && !service.error, `tools=[${tools.join(',')}]`);
    record('只注册 4 个工具且无识图/预热入口', tools.length === 4 && !tools.some(name => /inspect|warm|vision/i.test(name)));

    // 配置一个 provider（OpenAI-compatible），确认返回值只有掩码。
    // 这里的"密钥"是一个明显的占位串，不是任何真实凭据。
    const PLACEHOLDER_KEY = 'placeholder-value-not-a-real-key';
    const saved = service.saveConfig({
      image: {
        enabled: true,
        provider: 'openai',
        openai: { baseUrl: 'https://api.example.test/v1', apiKey: PLACEHOLDER_KEY, model: 'gpt-image-test', size: '1024x1024' },
      },
    });
    record('保存 provider 配置', saved.ok === true, saved.ok ? '' : JSON.stringify(saved.errors ?? saved.error));
    const maskedText = JSON.stringify(service.readConfig());
    record('GET 视图不含密钥明文', !maskedText.includes(PLACEHOLDER_KEY));
    record('密钥标记为已配置（掩码）', service.readConfig().config.image.openai.apiKey.configured === true);

    const tested = await service.testProvider({ kind: 'image', id: 'openai' });
    record('连接测试（mock /models）', tested.ok === true, `level=${tested.level}`);

    const drawn = await service.generateImage({ prompt: 'a synthetic lighthouse at dusk' });
    record('一次合成内容生图（mock，不产生费用）', drawn.ok === true, drawn.ok ? drawn.artifact.mime : JSON.stringify(drawn.error));
    const workspaceMedia = path.join(dataDir, 'workspace', 'media');
    record(
      '产物落在工作区 <dataRoot>/workspace/media（通道边界内）、且 handoff.delivered=false',
      Boolean(drawn.artifact?.absolutePath?.startsWith(workspaceMedia)) && drawn.handoff?.delivered === false,
      drawn.artifact?.absolutePath ?? '',
    );

    // "重启"：同一数据目录上新建一个服务实例
    const restarted = plugin.createMediaService({ dataDir, env: {}, fetchImpl: mock.fetchImpl });
    const afterRestart = restarted.readConfig();
    record('重启后配置仍在', afterRestart.config.image.enabled === true && afterRestart.exists === true);
    record('重启后密钥仍是掩码', afterRestart.config.image.openai.apiKey.configured === true && !JSON.stringify(afterRestart).includes(PLACEHOLDER_KEY));
    record('重启后产物仍在账本里', restarted.jobs(10).artifacts.length >= 1);

    // 仓库卫生：复制出来的树里不得有真实凭据、作者机器路径、媒体产物
    const offenders = scanTree(target);
    record('源码树无真实密钥/无作者路径/无媒体产物', offenders.length === 0, offenders.join('; '));

    const failed = results.filter(item => !item.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    console.log(JSON.stringify({ root, dataDir, failed: failed.map(item => item.name) }, null, 2));
    if (!keep && failed.length === 0) fs.rmSync(root, { recursive: true, force: true });
    else console.log(`临时目录保留在：${root}`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } catch (error) {
    console.error('verify-m5 failed:', error);
    console.error(`临时目录保留在：${root}`);
    process.exitCode = 1;
  }
}

await main();
