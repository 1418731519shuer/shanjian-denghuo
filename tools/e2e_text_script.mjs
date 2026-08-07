#!/usr/bin/env node
/* ============================================================================
 * e2e_text_script.mjs —— 文字脚本实战示例《灯下问仙》端到端测试
 * （真实 Edge headless + CDP，零依赖；基建复用自 e2e_test.mjs）
 *
 * 验证 tsc.py 文字脚本编译出的剧本在引擎里的真实行为：
 *   a. 加载无错，标题正确
 *   b. 数值门控选项：属性不够时 disabled 不可点；改引擎变量重渲染后可点
 *   c. A/B 分支各进各的剧情线
 *   d. require 场景门：数值不足进 fallback 结局；攒够数值进好结局
 *   e. localStorage endings 记录了两个以上不同结局
 *
 * 用法：node tools/e2e_text_script.mjs
 *   前置：python tools/tsc.py scripts/demo_branch.txt && python tools/build.py
 *         && python tools/build_text_demo.py   （产出 dist_text/）
 * 环境变量：E2E_EDGE / E2E_HTTP_PORT（默认 8124）/ E2E_CDP_PORT（默认 9224）/ E2E_KEEP=1
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist_text');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8124);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9224);
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const KEEP = !!process.env.E2E_KEEP;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= 进程管理 ================= */
const children = [];
function killTree(proc) {
  if (!proc || proc.killed) return;
  try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { proc.kill('SIGKILL'); } catch {} }
}
function cleanup() {
  if (KEEP) return;
  for (const p of children.splice(0)) killTree(p);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时: ' + what);
    await sleep(250);
  }
}

/* ================= CDP 客户端（原生 WebSocket） ================= */
class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new CDP(ws);
      ws.onopen = () => resolve(c);
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      ws.onclose = () => c.closed = true;
    });
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    this.closed = false;
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
      } else {
        (this.handlers.get(m.method) || []).forEach(fn => { try { fn(m.params); } catch {} });
      }
    };
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
}

/* ================= 测试基建 ================= */
let cdp = null;
const errors = [];
let errMark = 0;
const results = [];

async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception;
    throw new Error('页面求值失败: ' + (d && d.description ? d.description.split('\n')[0] : r.exceptionDetails.text) + ' | ' + expression.slice(0, 120));
  }
  return r.result.value;
}
const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const visible = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!(e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none'); })()`);
const sceneId = () => ev(`script.scenes[sceneIdx].id`);
const dlgText = () => ev(`document.getElementById('dlgtext').textContent`);
const newErrors = () => errors.slice(errMark);

async function runCase(name, fn) {
  errMark = errors.length;
  try {
    const note = (await fn()) || '';
    const ne = newErrors();
    const ok = ne.length === 0;
    results.push({ name, ok, note: [note, ne.length ? 'console错误×' + ne.length + ': ' + ne[0] : ''].filter(Boolean).join('　') });
  } catch (e) {
    results.push({ name, ok: false, note: e.message.split('\n')[0] });
  }
}

/* 当前等待状态：end / view / cg / inspect / choice / dlg */
const state = () => ev(`(() => {
  const vis = id => { const e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); };
  if (vis('end-screen')) return { t: 'end' };
  if (vis('viewlayer')) return { t: 'view' };
  if (vis('cglayer')) return { t: 'cg' };
  if (document.querySelector('#hotspots .hotspot')) return { t: 'inspect' };
  if (document.querySelector('#choices .choice-btn')) return { t: 'choice' };
  return { t: 'dlg', text: document.getElementById('dlgtext').textContent.slice(0, 30) };
})()`);

/* 推进一步（不点选项，选项由 clickChoice 显式处理） */
async function stepOnce(st) {
  if (st.t === 'inspect') { await click('#hotspots .hotspot'); await sleep(150); if (await visible('#viewlayer')) await click('#viewlayer'); }
  else if (st.t === 'view') await click('#viewlayer');
  else if (st.t === 'cg') await click('#cglayer');
  else if (st.t === 'dlg') await click('#dlg');
  else throw new Error('stepOnce 不处理状态: ' + st.t);
}

/* 推进直到进入 target 状态之一（默认 choice/end），返回该状态 */
async function advanceTo(targets = ['choice', 'end'], maxIter = 120) {
  for (let i = 0; i < maxIter; i++) {
    const st = await state();
    if (targets.includes(st.t)) return st;
    await stepOnce(st);
    await sleep(100);
  }
  throw new Error('推进 ' + maxIter + ' 步仍未到达 ' + targets.join('/'));
}

/* 点指定文本的选项；返回 'ok' / 'missing' / 'disabled' */
const clickChoice = text => ev(`(() => {
  const b = [...document.querySelectorAll('#choices .choice-btn')].find(x => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return 'missing';
  if (b.classList.contains('disabled')) return 'disabled';
  b.click(); return 'ok';
})()`);

const choiceState = text => ev(`(() => {
  const b = [...document.querySelectorAll('#choices .choice-btn')].find(x => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return 'missing';
  return b.classList.contains('disabled') ? 'disabled' : 'enabled';
})()`);

async function mustClick(text) {
  const r = await clickChoice(text);
  if (r !== 'ok') throw new Error(`选项「${text}」点击失败: ${r}`);
  await sleep(300);
}

/* 回标题开新一局（命名弹窗自动填） */
async function newGame(name) {
  if (!(await visible('#title-screen'))) {
    await ev(`backToTitle()`);
    await waitFor(() => visible('#title-screen'), 5000, '回标题');
  }
  await click('#btn-start');
  await sleep(400);
  if (await visible('#name-input-overlay')) {
    await ev(`(() => { const f = document.getElementById('name-input-field'); f.value = ${JSON.stringify(name)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('#name-input-confirm');
  }
  await waitFor(async () => {
    const st = await state();
    return st.t === 'choice' || (st.t === 'dlg' && (await dlgText()).length > 0) ? true : null;
  }, 8000, '新游戏首条内容');
}

/* ================= 主流程 ================= */
async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html')))
    throw new Error('dist_text/index.html 不存在，先跑 python tools/build_text_demo.py');

  /* 启动 http.server（伺服 dist_text/） */
  const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(BASE + '/index.html')).ok, 10000, 'http.server 就绪');

  /* 启动 headless Edge */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-e2e-text-'));
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(edge);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 15000, 'Edge CDP 就绪');

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('找不到 page target');
  cdp = await CDP.connect(page.webSocketDebuggerUrl);

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails;
    errors.push('未捕获异常: ' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
  });
  cdp.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error') errors.push('console.error: ' + p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  });
  cdp.on('Log.entryAdded', p => {
    const e = p.entry;
    if (e.level === 'error') errors.push(`log[${e.source}]: ${(e.text || '').slice(0, 300)}`);
  });

  await cdp.send('Page.navigate', { url: BASE + '/' });
  await waitFor(() => ev(`document.readyState === 'complete'`), 20000, '页面加载完成');
  await sleep(1200);

  /* ---------- 用例 a：加载无错，标题正确 ---------- */
  await runCase('a. 页面加载无错误，标题为《灯下问仙》', async () => {
    const title = await ev(`document.getElementById('game-title').textContent`);
    if (title !== '灯下问仙') throw new Error('标题不符: ' + title);
    const dom = await ev(`document.title`);
    if (dom !== '灯下问仙') throw new Error('<title> 不符: ' + dom);
    const nScenes = await ev(`script.scenes.length`);
    if (nScenes !== 8) throw new Error('场景数应为 8，实际 ' + nScenes);
    return `标题=${title}，场景×${nScenes}`;
  });

  /* ---------- 用例 b：数值门控选项 disabled ↔ 改变量后可点 ---------- */
  await runCase('b. 数值门控选项：属性不足 disabled，改变量后可点', async () => {
    await newGame('测试员甲');
    await advanceTo(['choice'], 60);
    if ((await sceneId()) !== 's1_town') throw new Error('首选项不在 s1_town: ' + await sceneId());
    const before = await choiceState('直接闯山门');
    if (before !== 'disabled') throw new Error('修为 0 时「直接闯山门 [xiuwei>=20]」应 disabled，实际 ' + before);
    /* 直接改引擎变量并重渲染选项（run() 重执行当前 choice 指令） */
    await ev(`vars.xiuwei = 30; run();`);
    await sleep(200);
    const after = await choiceState('直接闯山门');
    if (after !== 'enabled') throw new Error('改 xiuwei=30 后选项应可点，实际 ' + after);
    /* 还原变量，避免影响后续用例 */
    await ev(`vars.xiuwei = 0; run();`);
    await sleep(200);
    const restored = await choiceState('直接闯山门');
    if (restored !== 'disabled') throw new Error('还原 xiuwei=0 后应重新 disabled，实际 ' + restored);
    return 'disabled →(xiuwei=30)→ enabled →(还原)→ disabled';
  });

  /* ---------- 用例 c：A/B 分支各进各的剧情线 ---------- */
  await runCase('c. A 分支进放灯线，回标题重开 B 分支进闭关线', async () => {
    /* 接用例 b 的局面：s1_town 选项正显示着 */
    await mustClick('陪苏璃放灯');
    await advanceTo(['choice'], 60);
    if ((await sceneId()) !== 's2_lantern') throw new Error('A 分支应进 s2_lantern，实际 ' + await sceneId());
    /* B 分支：回标题重开 */
    await newGame('测试员乙');
    await advanceTo(['choice'], 60);
    await mustClick('去竹林闭关');
    await advanceTo(['choice'], 60);
    if ((await sceneId()) !== 's2_bamboo') throw new Error('B 分支应进 s2_bamboo，实际 ' + await sceneId());
    return 'A→s2_lantern，B→s2_bamboo';
  });

  /* ---------- 用例 d1：数值不足被 require 门拦进 fallback 结局 ---------- */
  await runCase('d1. 数值不足 → require 门拦到 s3_fallback → 结局·归隐茶棚', async () => {
    await newGame('测试员丙');
    await advanceTo(['choice'], 60);
    await mustClick('陪苏璃放灯');            // favor=6，不够 favor>=10
    await advanceTo(['choice'], 60);
    await mustClick('默默离开');               // 不拿 favor+6
    await sleep(500);
    const sid = await sceneId();
    if (sid !== 's3_fallback') throw new Error('require 未拦住，进了 ' + sid);
    await advanceTo(['end'], 60);
    const label = await ev(`document.getElementById('end-label').textContent`);
    if (!label.includes('归隐茶棚')) throw new Error('结局名不符: ' + label);
    return `require 拦截 → s3_fallback，${label}`;
  });

  /* ---------- 用例 d2：攒够好感 → 过 require 门 → 好结局 ---------- */
  await runCase('d2. 选项攒数值 → 过 require 门 → 结局·灯火良缘', async () => {
    await newGame('测试员丁');
    await advanceTo(['choice'], 60);
    await mustClick('陪苏璃放灯');            // favor=6
    await advanceTo(['choice'], 60);
    await mustClick('买下那只兔子灯');         // [favor>=5] 门控，{favor+6} → favor=12
    await sleep(500);
    const sid = await sceneId();
    if (sid !== 's3_test') throw new Error('应过 require 门进 s3_test，实际 ' + sid);
    const favor = await ev(`vars.favor`);
    await advanceTo(['choice'], 60);
    await mustClick('与苏璃归隐灯下');         // [favor>=12] 门控
    await sleep(500);
    const sid2 = await sceneId();
    if (sid2 !== 's_end_love') throw new Error('应进 s_end_love，实际 ' + sid2);
    await advanceTo(['end'], 60);
    const label = await ev(`document.getElementById('end-label').textContent`);
    if (!label.includes('灯火良缘')) throw new Error('结局名不符: ' + label);
    return `favor=${favor} 过门 → s3_test → s_end_love，${label}`;
  });

  /* ---------- 用例 e：localStorage endings 记录 ≥2 个不同结局 ---------- */
  await runCase('e. localStorage endings 记录两个以上不同结局', async () => {
    const ends = await ev(`JSON.parse(localStorage.getItem('wenyou_灯下问仙_endings') || '[]')`);
    if (!Array.isArray(ends) || ends.length < 2) throw new Error('endings 不足 2 个: ' + JSON.stringify(ends));
    for (const want of ['归隐茶棚', '灯火良缘'])
      if (!ends.includes(want)) throw new Error(`endings 缺「${want}」: ` + JSON.stringify(ends));
    return `endings=${JSON.stringify(ends)}`;
  });

  /* ================= 汇总 ================= */
  console.log('\n=========== E2E（文字脚本）结果 ===========');
  let pass = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? '\n      ' + r.note : ''}`);
    if (r.ok) pass++;
  }
  console.log('------------------------------------------');
  console.log(`${pass}/${results.length} 通过；页面累计 console/异常错误 ${errors.length} 条`);
  if (errors.length) {
    console.log('---- 全部页面错误 ----');
    [...new Set(errors)].slice(0, 30).forEach(e => console.log('  ' + e));
  }
  cleanup();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error('E2E 运行失败:', e); cleanup(); process.exit(2); });
