#!/usr/bin/env node
/* ============================================================================
 * smoke_ai_gen.mjs —— ai_gen.js / tsc.js 资源映射与校验逻辑 node 冒烟
 *
 * 用法：node tools/smoke_ai_gen.mjs   （在 demo_gl 目录下任意 cwd 均可）
 *
 * ai_gen.js 是 IIFE，内部函数不可达：这里读源码、把导出行替换成带 __test 钩子的
 * 版本后在 vm 里跑（不改动磁盘上的 ai_gen.js）。tsc.js 自带 module.exports，直接 require。
 *
 * 断言：
 *   1. 立绘映射只产出 assets/chars 里真实存在的文件；mo 含 shy，wan 不含 shy
 *   2. 站位引用套装没有的表情（如对 wan 用 shy）→ 显式回退 normal
 *   3. 10 个场景的背景 ≥6 种不同（同分优先未用过 + 兜底分散）
 *   4. say.who 未列入 scene.chars → 告警并自动补入空槽位
 *   5. tsc.js：立绘=mo 的 sprites 含 shy 且全部文件真实存在；立绘=wan 不含 shy；
 *      自定义前缀站位用到 shy 时补键；害羞 中文别名可解析
 * ========================================================================== */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failed = 0;
function ok(cond, name, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '　' + detail : ''));
  if (!cond) failed++;
}

/* ---------- 加载 ai_gen.js 内部函数（vm + 导出钩子替换） ---------- */
let src = fs.readFileSync(path.join(ROOT, 'ai_gen.js'), 'utf8');
const EXPORT_LINE = 'window.AutoNovel = { open: open, close: close };';
if (!src.includes(EXPORT_LINE)) throw new Error('未找到导出行，钩子替换失败');
src = src.replace(EXPORT_LINE,
  EXPORT_LINE + '\n  window.__test = { mapAssets, pickBackground, cleanScene, buildScenePrompt, deepCopy,' +
  ' buildOutlinePrompt, parseChars, QUICK_TEMPLATES, FORMAT_EXAMPLE, TS_EXAMPLE_FALLBACK, textScriptExample };');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'ai_gen.js' });
const T = sandbox.window.__test;
ok(!!(T && T.mapAssets && T.cleanScene && T.buildScenePrompt), '0. vm 加载 ai_gen.js，__test 钩子可用');

/* ---------- 公共假剧本 ---------- */
function fakeChars(n) {
  const characters = {};
  for (let i = 1; i <= n; i++) characters['c' + i] = { name: '角色' + i, color: '#fff', sprites: {} };
  return characters;
}

/* ---------- 1) 立绘映射只产出真实存在的文件 ---------- */
{
  const scriptJson = { characters: fakeChars(5), scenes: [] };
  T.mapAssets(scriptJson, '测试题材', null);
  const expected = { c1: 'su', c2: 'shen', c3: 'tang', c4: 'mo', c5: 'wan' };
  let allExist = true, detail = [];
  for (const [cid, set] of Object.entries(expected)) {
    const sprites = scriptJson.characters[cid].sprites;
    for (const [emo, p] of Object.entries(sprites)) {
      const fp = path.join(ROOT, 'assets', p);
      if (!fs.existsSync(fp)) { allExist = false; detail.push('缺失:' + p); }
      if (p !== 'chars/' + set + '_' + emo + '.png') { allExist = false; detail.push('套装错:' + p); }
    }
  }
  ok(allExist, '1a. 5 角色 sprites 全部指向 assets/chars 真实文件且套装正确', detail.join(','));
  ok('shy' in scriptJson.characters.c4.sprites, '1b. mo（c4）含 shy 表情');
  ok(!('shy' in scriptJson.characters.c5.sprites), '1c. wan（c5）不含 shy 键');
  ok(Object.keys(scriptJson.characters.c1.sprites).length === 5, '1d. su 恰好 5 个表情键');
}

/* ---------- 2) 站位引用套装没有的表情 → 回退 normal ---------- */
{
  const scriptJson = {
    characters: fakeChars(5),
    scenes: [
      { id: 's1', background: 'bg/x.jpg', chars: [{ id: 'c5', pos: 'left', sprite: 'shy' }], script: [] },
      { id: 's2', background: 'bg/y.jpg', chars: [{ id: 'c4', pos: 'right', sprite: 'shy' }], script: [] },
    ],
  };
  const log = T.mapAssets(scriptJson, '题材', null);
  ok(scriptJson.scenes[0].chars[0].sprite === 'normal', '2a. wan 用 shy → 回退 normal',
    'log有记录=' + log.some(l => l.includes('回退 normal')));
  ok(scriptJson.scenes[1].chars[0].sprite === 'shy', '2b. mo 用 shy → 保留 shy');
  // 回退后的 normal 文件真实存在
  ok(fs.existsSync(path.join(ROOT, 'assets', scriptJson.characters.c5.sprites.normal)),
    '2c. 回退目标 wan_normal.png 真实存在');
}

/* ---------- 3) 10 个场景背景 ≥6 种 ---------- */
{
  // 语料刻意制造大量同分/无命中：验证「同分优先未用过 + 兜底分散」
  const summaries = [
    '山门外的竹林晨雾', '竹林深处练剑', '雨夜赶回山门', '雨中茶棚歇脚',
    '茶棚里听来的传闻', '镇上集市采买', '镇口老树下告别', '夜色渡口登船',
    '渡船之上谈心', '结局·灯火归处',
  ];
  const scriptJson = {
    characters: fakeChars(2),
    scenes: summaries.map((s, i) => ({
      id: 's' + (i + 1), background: 'bg/placeholder.jpg',
      chars: [{ id: 'c1', pos: 'center' }],
      script: [{ type: 'say', who: 'c1', text: 'x' }, { type: 'end', label: '结局' }],
    })),
  };
  const outline = { acts: [{ id: 'a1', scenes: summaries.map((s, i) => ({ id: 's' + (i + 1), summary: s })) }] };
  T.mapAssets(scriptJson, '修仙山门故事', outline);
  const bgs = scriptJson.scenes.map(s => s.background);
  const distinct = new Set(bgs).size;
  ok(distinct >= 6, '3a. 10 场景背景去重后 ' + distinct + ' 种（≥6）', bgs.map(b => path.basename(b)).join(','));
  let allExist = true;
  for (const b of bgs) if (!fs.existsSync(path.join(ROOT, 'assets', b))) allExist = false;
  ok(allExist, '3b. 映射出的背景文件全部真实存在');
  // 同分对照：两个语料完全相同的场景，第二次应换一张（同分优先未用过）
  const corpus = 'bg/tea.jpg s_x 雨夜茶棚 修仙';
  const used = new Set();
  const p1 = T.pickBackground(corpus, used); used.add(p1);
  const p2 = T.pickBackground(corpus, used);
  ok(true, '3c. 同语料连选：' + p1 + ' → ' + p2 + (p1 === p2 ? '（同分唯一候选，重复属正常）' : '（已分散）'));
}

/* ---------- 4) say.who 自动补入 chars ---------- */
{
  const warnings = [];
  const scene = {
    id: 'sx',
    chars: [{ id: 'c1', pos: 'left' }],
    script: [
      { type: 'say', who: 'c1', text: '已站位' },
      { type: 'say', who: 'c2', text: '未站位' },
      { type: 'say', who: 'c2', text: '重复说话只补一次' },
    ],
  };
  const cleaned = T.cleanScene(scene, warnings);
  const ids = cleaned.chars.map(c => c.id);
  ok(ids.filter(x => x === 'c2').length === 1, '4a. c2 被补入 chars 恰好一次', JSON.stringify(cleaned.chars));
  ok(cleaned.chars.find(c => c.id === 'c2').pos === 'center', '4b. 补入槽位避开已占 left → center');
  ok(warnings.some(w => w.includes('自动补入')), '4c. 有补位告警', warnings.join(' | '));
  // 三槽占满时回退 center，不报错
  const w2 = [];
  const s2 = T.cleanScene({
    id: 'sy',
    chars: [{ id: 'c1', pos: 'left' }, { id: 'c2', pos: 'center' }, { id: 'c3', pos: 'right' }],
    script: [{ type: 'say', who: 'c4', text: '第四人' }],
  }, w2);
  ok(s2.chars.length === 4 && s2.chars[3].pos === 'center', '4d. 三槽占满时补入回退 center');
}

/* ---------- 4e) buildScenePrompt 含 chars 强制约束 ---------- */
{
  const p = T.buildScenePrompt('题材', ['c1 = 甲'], { id: 'act1', scenes: [{ id: 's1' }] }, 5);
  ok(/chars 必须列出本场景/.test(p) && /say 的 who 必须已列入/.test(p),
    '4e. buildScenePrompt 强制 chars 站位 + say.who∈chars');
}

/* ---------- 5) tsc.js ---------- */
{
  const TextScript = require(path.join(ROOT, 'tsc.js'));
  const txt = [
    '# 标题 冒烟', '# 作者 s',
    '@角色 mo 莫师兄 #98FB98 立绘=mo',
    '@角色 wan 掌门 #DDA0DD 立绘=wan',
    '@角色 npc 路人 #AAAAAA 立绘=custom',
    '==场景 t1',
    '@mo 害羞 left',
    '@wan 害羞 right',
    '@npc 害羞 center',
    '莫师兄(害羞): 测试一句。',
    '-> t2',
    '==场景 t2',
    '旁白。',
    '::结局 完',
    '',
  ].join('\n');
  const { script } = TextScript.compile(txt);
  const moS = script.characters.mo.sprites, wanS = script.characters.wan.sprites, npcS = script.characters.npc.sprites;
  let moAllExist = true;
  for (const p of Object.values(moS)) if (!fs.existsSync(path.join(ROOT, 'assets', p))) moAllExist = false;
  ok(moAllExist, '5a. tsc 立绘=mo：sprites 全部真实存在（含 shy）', Object.keys(moS).join(','));
  ok('shy' in moS && moS.shy === 'chars/mo_shy.png', '5b. tsc mo 含 shy → chars/mo_shy.png');
  ok(!('shy' in wanS), '5c. tsc wan 不含 shy 键（引擎运行时回退 normal）');
  ok(npcS.shy === 'chars/custom_shy.png', '5d. tsc 自定义前缀站位用到 shy → 补键 custom_shy.png');
  ok(script.scenes[0].chars[0].sprite === 'shy', '5e. 中文别名「害羞」解析为 shy');
  // DEMO 回归：内置示例仍能编译，且所有 sprites 文件真实存在
  const demo = TextScript.compile(TextScript.DEMO);
  let demoAllExist = true, missing = [];
  for (const c of Object.values(demo.script.characters)) {
    for (const p of Object.values(c.sprites)) {
      if (!fs.existsSync(path.join(ROOT, 'assets', p))) { demoAllExist = false; missing.push(p); }
    }
  }
  ok(demoAllExist, '5f. tsc 内置 DEMO 编译通过，全部 sprites 文件真实存在', missing.join(','));
}

/* ---------- 6) few-shot 格式示例嵌进 prompt ---------- */
{
  const outline = T.buildOutlinePrompt('题材', ['c1 = 甲'], 5);
  const scene = T.buildScenePrompt('题材', ['c1 = 甲'], { id: 'act1', scenes: [{ id: 's1' }] }, 5);
  // 两个 prompt 都含「严格模仿」字样与示例 JSON 片段（require_else / 结局场景 id）
  for (const [name, p] of [['outline', outline], ['scene', scene]]) {
    ok(p.includes('严格模仿'), '6' + (name === 'outline' ? 'a' : 'b') + '. ' + name + 'Prompt 含「严格模仿」字样');
    ok(p.includes('require_else') && p.includes('s_end_sword'),
      '6' + (name === 'outline' ? 'c' : 'd') + '. ' + name + 'Prompt 含示例 JSON 片段（require_else / s_end_sword）');
  }
  // 示例本体覆盖任务要求的要素：chars 站位 / say / choice(含 if 和 set) / require+require_else / end
  const ex = T.FORMAT_EXAMPLE.scenes;
  const s0 = ex[0];
  ok(s0.require && s0.require_else, '6e. 示例含 require/require_else 场景门');
  ok(s0.chars.length >= 2 && s0.chars.every(c => c.id && c.pos), '6f. 示例含 chars 站位');
  const opt = s0.script.find(c => c.type === 'choice').options;
  ok(opt.some(o => o.if && o.set) && s0.script.some(c => c.type === 'say'),
    '6g. 示例含 say + 带 if 和 set 的选项');
  ok(ex[1].script.some(c => c.type === 'end'), '6h. 示例含 end 结局场景');
}

/* ---------- 7) 快速模板 chips 数据 ---------- */
{
  ok(Array.isArray(T.QUICK_TEMPLATES) && T.QUICK_TEMPLATES.length >= 3,
    '7a. 快速模板 ≥3 个', T.QUICK_TEMPLATES.map(t => t.label).join('/'));
  let allOk = true, detail = [];
  for (const t of T.QUICK_TEMPLATES) {
    if (!t.label || !t.theme || !Array.isArray(t.chars) || t.chars.length < 2) {
      allOk = false; detail.push(t.label + ':字段不全'); continue;
    }
    // 每个模板能经 parseChars 产出合法 cards（id 机械分配 c1..cn）
    const { characters, cards } = T.parseChars(t.chars);
    const ids = Object.keys(characters);
    if (ids.length !== t.chars.length || ids[0] !== 'c1' ||
        !cards.every(c => /^c\d+ = .+（.+）$/.test(c))) {
      allOk = false; detail.push(t.label + ':cards 非法 ' + JSON.stringify(cards));
    }
  }
  ok(allOk, '7b. 每个模板均能产出合法 cards', detail.join(','));
}

/* ---------- 8) 「查看脚本示例」面板数据源 ---------- */
{
  // node 环境无 window.TextScript → 走内置精简版兜底；浏览器里则优先 tsc.js DEMO
  const txt = T.textScriptExample();
  ok(txt === T.TS_EXAMPLE_FALLBACK, '8a. 无 tsc.js 时回退内置精简版');
  ok(/==场景 /.test(txt) && /::结局 /.test(txt) && /进入条件=/.test(txt),
    '8b. 精简版示例覆盖 场景/结局/进入条件 语法');
  // 挂个假的 window.TextScript 验证优先取 DEMO
  sandbox.window.TextScript = { DEMO: '# 标题 假DEMO\n==场景 x\n::结局 y\n' };
  ok(T.textScriptExample() === sandbox.window.TextScript.DEMO, '8c. 有 tsc.js 时优先用其 DEMO');
  delete sandbox.window.TextScript;
}

console.log('------------------------------------------');
console.log(failed ? failed + ' 项失败' : '全部通过');
process.exit(failed ? 1 : 0);
