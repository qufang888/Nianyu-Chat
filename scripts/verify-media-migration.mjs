// v2.3.94 需求 7 迁移逻辑的可证伪验证（TTS/ASR/生图/生视频 多 API 配置）
// 用法：node scripts/verify-media-migration.mjs
// 做法：把 electron/db.ts 里的迁移/同步两段逻辑原样抠出来（避免 import electron），
// 用最小 AppSettings 桩跑真数据。这是「跑过测试」而不是「看代码觉得对」。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const DB = fs.readFileSync(path.join(ROOT, 'electron', 'db.ts'), 'utf-8');

// ---- 从 db.ts 抠出真函数（取源码文本，编译执行，保证测的就是线上那套）----
// 注意 1：抽取要同时匹配 export 与非 export（newMediaConfigId / guessProviderByUrl 是模块内私有）。
// 注意 2：**必须用括号配平定位函数末尾**，不能用 '\n}\n' 找 —— 函数体里出现行首 '}' 时
//         （如多行模板串、对象字面量换行）会提前截断，导致抽取失败或抽出半截代码。
//         这正是第一版抽取器的 bug：它让「可证伪性检验」跑成了崩溃而非干净失败，结论无效。
function extractFn(name) {
  const re = new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = DB.match(re);
  if (!m) throw new Error(`db.ts 里找不到 ${name}`);
  const start = m.index;
  // 从函数体的第一个 '{' 开始做花括号配平（跳过字符串/模板串/注释里的括号）
  const bodyStart = DB.indexOf('{', start + m[0].length - 1);
  if (bodyStart < 0) throw new Error(`${name} 找不到函数体起始 {`);
  let depth = 0;
  let i = bodyStart;
  let inS = false, inD = false, inT = false, inLine = false, inBlock = false;
  for (; i < DB.length; i++) {
    const c = DB[i], n = DB[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inS) { if (c === '\\') { i++; continue; } if (c === "'") inS = false; continue; }
    if (inD) { if (c === '\\') { i++; continue; } if (c === '"') inD = false; continue; }
    if (inT) {
      if (c === '\\') { i++; continue; }
      if (c === '`') { inT = false; continue; }
      if (c === '$' && n === '{') {
        // 模板串插值：递归做一次花括号配平，跳过整个 ${...}（内部可含字符串/嵌套模板）
        i += 2;               // 指向 ${ 之后
        let d2 = 1;
        while (i < DB.length && d2 > 0) {
          const ch = DB[i];
          if (ch === '\\') { i += 2; continue; }
          if (ch === '{') d2++;
          else if (ch === '}') d2--;
          i++;
        }
        i--;                  // for 循环再 ++ 回到模板串内
        continue;
      }
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === '`') { inT = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return DB.slice(start, i + 1); }
  }
  throw new Error(`${name} 括号配平失败，函数未闭合`);
}

// 抠出来的代码带 TS 类型注解，必须转译成 JS 才能执行。用项目已装的 esbuild（离线）。
import { build } from 'esbuild';

const src = [
  `type MediaApiConfig = any; type AppSettings = any; type TtsProviderInfo = any;`,
  `const TTS_PROVIDERS: TtsProviderInfo[] = ${JSON.stringify([
    { id: 'openai-native', match: 'api.openai.com' },
    { id: 'openai-compatible', match: '/audio/speech' },
    { id: 'azure', match: 'tts.speech.microsoft.com' },
    { id: 'elevenlabs', match: 'api.elevenlabs.io' },
  ])};`,
  extractFn('newMediaConfigId'),
  extractFn('guessProviderByUrl'),
  extractFn('resolveMediaConfig'),
  extractFn('migrateMediaApiConfigs'),
  extractFn('syncActiveMediaConfigs'),
].join('\n\n');

const tmp = path.join(os.tmpdir(), `ny-media-mig-${Date.now()}.mjs`);
await build({
  stdin: { contents: src, loader: 'ts', resolveDir: ROOT },
  outfile: tmp,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
// Windows 上绝对路径必须转 file:// URL，否则 ERR_UNSUPPORTED_ESM_URL_SCHEME
const { migrateMediaApiConfigs, syncActiveMediaConfigs, resolveMediaConfig } = await import(pathToFileURL(tmp).href);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  FAIL  ${name} ${extra}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// 造一个「老用户」settings：只有扁平字段，没有多配置数组
function legacySettings() {
  return {
    voice: {
      asrBaseUrl: 'https://api.openai.com/v1',
      asrApiKey: 'sk-asr',
      asrModel: 'whisper-1',
      ttsBaseUrl: 'https://api.openai.com/v1',
      ttsApiKey: 'sk-tts',
      ttsModel: 'tts-1',
      ttsVoice: 'alloy',
      ttsAutoPlay: false,
    },
    imageGen: { enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-img', model: 'gpt-image-1', size: '1024x1024' },
    videoGen: { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', duration: '5', size: '1280x720' },
  };
}

// ------------------------------------------------------------------
section('A. 老用户迁移：扁平字段 → 多配置数组（不丢数据）');
{
  const s = legacySettings();
  migrateMediaApiConfigs(s);
  check('TTS 生成 1 条配置', s.voice.ttsConfigs.length === 1, `实际 ${s.voice.ttsConfigs?.length}`);
  check('TTS baseUrl 未丢', s.voice.ttsConfigs[0].baseUrl === 'https://api.openai.com/v1');
  check('TTS apiKey 未丢', s.voice.ttsConfigs[0].apiKey === 'sk-tts');
  check('TTS model 未丢', s.voice.ttsConfigs[0].model === 'tts-1');
  check('TTS voice 未丢', s.voice.ttsConfigs[0].voice === 'alloy');
  check('TTS provider 按 URL 推断为 openai-native', s.voice.ttsConfigs[0].provider === 'openai-native', s.voice.ttsConfigs[0].provider);
  check('ASR 生成 1 条配置', s.voice.asrConfigs.length === 1);
  check('ASR model 未丢', s.voice.asrConfigs[0].model === 'whisper-1');
  check('生图生成 1 条配置', s.imageGen.imageConfigs.length === 1);
  check('生图 model 未丢', s.imageGen.imageConfigs[0].model === 'gpt-image-1');
  check('生图 size 未丢', s.imageGen.imageConfigs[0].size === '1024x1024');
  check('生视频生成 1 条配置', s.videoGen.videoConfigs.length === 1);
}

section('B. 迁移幂等：跑两次不重复生成');
{
  const s = legacySettings();
  migrateMediaApiConfigs(s);
  const ids1 = s.voice.ttsConfigs.map((c) => c.id);
  migrateMediaApiConfigs(s);
  const ids2 = s.voice.ttsConfigs.map((c) => c.id);
  check('TTS 仍只有 1 条（未重复）', s.voice.ttsConfigs.length === 1, `实际 ${s.voice.ttsConfigs.length}`);
  check('TTS id 未被重新生成', JSON.stringify(ids1) === JSON.stringify(ids2));
  check('生图仍只有 1 条', s.imageGen.imageConfigs.length === 1);
}

section('C. 新用户（什么都没配）：不生成假配置');
{
  const s = { voice: { ttsBaseUrl: '', ttsApiKey: '', ttsModel: '', ttsVoice: '' }, imageGen: { baseUrl: '', apiKey: '', model: '' } };
  migrateMediaApiConfigs(s);
  check('TTS 数组保持为空', s.voice.ttsConfigs.length === 0, `实际 ${s.voice.ttsConfigs.length}`);
  check('生图数组保持为空', s.imageGen.imageConfigs.length === 0);
}

section('D. 用户真配了多条：迁移不得覆盖用户配置');
{
  const mine = [
    { id: 'tts_a', name: '主号', provider: 'azure', baseUrl: 'https://x1', apiKey: 'k1', model: 'm1', voice: 'v1' },
    { id: 'tts_b', name: '备用', provider: 'elevenlabs', baseUrl: 'https://x2', apiKey: 'k2', model: 'm2', voice: 'v2' },
  ];
  const s = legacySettings();
  s.voice.ttsConfigs = mine;
  s.voice.activeTtsId = 'tts_b';
  migrateMediaApiConfigs(s);
  check('仍为用户的 2 条', s.voice.ttsConfigs.length === 2, `实际 ${s.voice.ttsConfigs.length}`);
  check('内容未被改写', JSON.stringify(s.voice.ttsConfigs) === JSON.stringify(mine));
}

section('E. 同步：切到「备用」配置后，扁平字段跟随（老调用点零改动可用）');
{
  const s = legacySettings();
  migrateMediaApiConfigs(s);
  // 用户在界面添加第二条并切过去
  s.voice.ttsConfigs.push({ id: 'tts_b', name: '备用', provider: 'elevenlabs', baseUrl: 'https://backup', apiKey: 'kb', model: 'mb', voice: 'vb' });
  s.voice.activeTtsId = 'tts_b';
  syncActiveMediaConfigs(s);
  check('扁平 baseUrl 切到备用', s.voice.ttsBaseUrl === 'https://backup', s.voice.ttsBaseUrl);
  check('扁平 apiKey 切到备用', s.voice.ttsApiKey === 'kb');
  check('扁平 model 切到备用', s.voice.ttsModel === 'mb');
  check('扁平 voice 切到备用', s.voice.ttsVoice === 'vb');
  check('activeTtsId 被补齐', s.voice.activeTtsId === 'tts_b');
}

section('F. 同步：删除当前启用项后，回退到第一条而不是崩溃');
{
  const s = legacySettings();
  migrateMediaMediaFallbackCheck: {
    migrateMediaApiConfigs(s);
    s.voice.ttsConfigs = [
      { id: 'tts_a', name: 'A', provider: 'azure', baseUrl: 'https://a', apiKey: 'ka', model: 'ma', voice: 'va' },
      { id: 'tts_b', name: 'B', provider: 'azure', baseUrl: 'https://b', apiKey: 'kb', model: 'mb', voice: 'vb' },
    ];
    s.voice.activeTtsId = 'tts_b';
    s.voice.ttsConfigs = [s.voice.ttsConfigs[0]]; // 删掉当前启用的 B
    syncActiveMediaConfigs(s);                       // activeId 悬空
    check('未抛异常', true);
    check('回退到剩余的第一条', s.voice.ttsBaseUrl === 'https://a', s.voice.ttsBaseUrl);
  }
}

section('G. 边界：脏数据不崩');
{
  const s = { voice: { ttsBaseUrl: 'https://x', ttsApiKey: '', ttsModel: '', ttsConfigs: 'not-an-array' }, imageGen: { baseUrl: 'u', imageConfigs: null } };
  let threw = null;
  try { migrateMediaApiConfigs(s); } catch (e) { threw = e; }
  check('脏数组类型不崩', threw === null, threw ? String(threw) : '');
  check('脏字符串被纠正为数组', Array.isArray(s.voice.ttsConfigs));
  check('null 被纠正为数组', Array.isArray(s.imageGen.imageConfigs));
}

section('H. resolveMediaConfig 三条取用路径');
{
  const arr = [
    { id: 'a', name: 'A', provider: 'x', baseUrl: 'A', apiKey: '', model: 'ma' },
    { id: 'b', name: 'B', provider: 'x', baseUrl: 'B', apiKey: '', model: 'mb' },
  ];
  check('有数组无 activeId → 第一条', resolveMediaConfig(arr, undefined, {}).id === 'a');
  check('有数组有 activeId → 命中项', resolveMediaConfig(arr, 'b', {}).id === 'b');
  check('activeId 悬空 → 回落第一条', resolveMediaConfig(arr, 'zzz', {}).id === 'a');
  check('数组空 + 有扁平 → 用扁平', resolveMediaConfig([], undefined, { baseUrl: 'FLAT', model: 'mf' }).baseUrl === 'FLAT');
  check('数组空 + 无扁平 → undefined', resolveMediaConfig([], undefined, {}) === undefined);
}

console.log(`\n${'='.repeat(52)}`);
console.log(`断言：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
fs.unlinkSync(tmp);
process.exit(fail === 0 ? 0 : 1);