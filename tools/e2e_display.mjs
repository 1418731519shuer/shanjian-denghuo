#!/usr/bin/env node
/* ============================================================================
 * e2e_display.mjs —— 全场景显示审计（背景/人物渲染正确性）
 *
 * 复用 e2e_test.mjs 基建（python http.server + headless Edge + 原生 CDP）。
 * 对两个构建产物的**每一个场景**直接用引擎内部 enterScene(i) 进入，逐场景断言：
 *   - 背景：.bg.on 的 background-image 是真实图片且加载成功（naturalWidth>0），
 *           不是 .placeholder 渐变；"none"=纯黑；省略=沿用上场景（按 schema 规则）
 *   - 人物：每个应出场角色（槽位/自由位）渲染的是 <img> 且 naturalWidth>0，不是剪影
 *   - 场景切换后旧人物正确清场/保留（chars 省略=沿用）
 *
 * 用法：node tools/e2e_display.mjs
 * 环境变量：
 *   E2E_EDGE        Edge 可执行文件路径
 *   E2E_DIST_PORT   dist/ 伺服端口（默认 8126）
 *   E2E_TEXT_PORT   dist_text/ 伺服端口（默认 8128）
 *   E2E_CDP_PORT    CDP 调试端口（默认 9226）
 *   E2E_KEEP=1      结束后不杀进程（调试用）
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DIST_TEXT = path.join(ROOT, 'dist_text');
const DIST_PORT = Number(process.env.E2E_DIST_PORT || 8126);
const TEXT_PORT = Number(process.env.E2E_TEXT_PORT || 8128);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9226);
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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

/* ================= 审计逻辑 ================= */
let cdp = null;
const pageErrors = [];

async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception;
    throw new Error('页面求值失败: ' + (d && d.description ? d.description.split('\n')[0] : r.exceptionDetails.text) + ' | ' + expression.slice(0, 120));
  }
  return r.result.value;
}

/* 页面内快照：当前背景 + 所有渲染中的人物节点 */
const SNAPSHOT_JS = `(async () => {
  const bgEl = [...document.querySelectorAll('.bg')].find(e => e.classList.contains('on'));
  let bg = null;
  if (bgEl) {
    const cs = getComputedStyle(bgEl);
    const m = cs.backgroundImage.match(/url\\("?(.*?)"?\\)/);
    bg = { placeholder: bgEl.classList.contains('placeholder'), url: m ? m[1] : null, color: cs.backgroundColor };
    if (bg.url) bg.ok = await new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth > 0); i.onerror = () => res(false); i.src = bg.url; });
  }
  const chars = [];
  for (const pos of ['left','center','right']) {
    const el = document.getElementById('slot-' + pos);
    const node = el.querySelector('img,.silhouette');
    if (!node) continue;
    chars.push({ where: 'slot:' + pos, id: slots[pos] && slots[pos].id, sprite: slots[pos] && slots[pos].sprite,
      tag: node.tagName, src: node.tagName === 'IMG' ? node.src : null,
      ok: node.tagName === 'IMG' && node.complete && node.naturalWidth > 0 });
  }
  document.querySelectorAll('#fchars .fchar').forEach(w => {
    const node = w.querySelector('img,.silhouette');
    chars.push({ where: 'free', id: w.dataset.fid, tag: node ? node.tagName : null,
      src: node && node.tagName === 'IMG' ? node.src : null,
      ok: !!node && node.tagName === 'IMG' && node.complete && node.naturalWidth > 0 });
  });
  return { sceneIdx, sceneId: script.scenes[sceneIdx] ? script.scenes[sceneIdx].id : '?', bg, chars };
})()`;

/* 背景/人物渲染是否已稳定（图片加载完成或已降级） */
const SETTLED_JS = `(() => {
  const bgEl = [...document.querySelectorAll('.bg')].find(e => e.classList.contains('on'));
  const bgReady = !!bgEl && (bgEl.classList.contains('placeholder')
    || getComputedStyle(bgEl).backgroundImage !== 'none'
    || getComputedStyle(bgEl).backgroundColor === 'rgb(0, 0, 0)');
  const imgs = [...document.querySelectorAll('.slot img, .fchar img')];
  return bgReady && imgs.every(i => i.complete);
})()`;

/* 逐场景审计一个目标（dist 或 dist_text）。返回行结果数组。 */
async function auditTarget(label, base, rows) {
  await cdp.send('Page.navigate', { url: base + '/' });
  await waitFor(() => ev(`document.readyState === 'complete' && typeof enterScene === 'function'`), 20000, label + ' 页面加载');
  await sleep(800);

  /* 拿剧本场景定义（id/background/chars/say 说话人），在 node 侧算预期 */
  const scenes = await ev(`JSON.stringify(script.scenes.map(s => ({
    id: s.id, background: s.background,
    chars: s.chars === undefined ? null : (s.chars || []).map(c => ({ id: c.id, pos: c.pos || null, free: c.x !== undefined || c.y !== undefined })),
    speakers: [...new Set((s.script || []).filter(c => c.type === 'say').map(c => c.who))],
    require: s.require || null, require_else: s.require_else || null
  })))`).then(JSON.parse);

  /* 进入游戏态（跳过命名流程）；属性拉满保证 require 场景可进 */
  await ev(`(() => {
    document.getElementById('title-screen').classList.add('hidden');
    document.getElementById('end-screen').classList.add('hidden');
    Object.entries(script.attrs || {}).forEach(([k, a]) => { vars[k] = a.max !== undefined ? a.max : 99; });
    startTime = Date.now();
  })()`);

  /* eff 状态按「实际进入的场景」推演（require 跳转后 sceneIdx 会变） */
  const eff = new Map(); // sceneIdx -> { bg, chars }
  let curBg, curChars;

  for (let i = 0; i < scenes.length; i++) {
    const want = scenes[i];
    await ev(`(() => {
      document.getElementById('end-screen').classList.add('hidden');
      document.getElementById('cglayer').classList.add('hidden');
      document.getElementById('viewlayer').classList.add('hidden');
      enterScene(${i});
    })()`);
    await waitFor(() => ev(SETTLED_JS), 6000, `${want.id} 渲染稳定`);
    await sleep(150);
    const snap = await ev(SNAPSHOT_JS);
    const actual = scenes[snap.sceneIdx] || want;
    const jumped = snap.sceneIdx !== i;

    /* ---- 预期计算（沿用规则按实际进入链推演） ---- */
    if (actual.background !== undefined) curBg = actual.background;
    if (actual.chars !== null) curChars = actual.chars;
    const expBg = curBg, expChars = curChars || [];

    const problems = [];

    /* ---- 背景断言 ---- */
    let bgOk;
    if (expBg === 'none') {
      bgOk = snap.bg && !snap.bg.url && snap.bg.color === 'rgb(0, 0, 0)';
      if (!bgOk) problems.push(`背景应为纯黑，实际 url=${snap.bg && snap.bg.url} color=${snap.bg && snap.bg.color}`);
    } else if (expBg) {
      bgOk = snap.bg && !snap.bg.placeholder && !!snap.bg.url && snap.bg.ok === true;
      if (!bgOk) problems.push(`背景 ${expBg} ${snap.bg && snap.bg.placeholder ? '是 placeholder 渐变' : snap.bg && snap.bg.url ? '加载失败 ' + snap.bg.url : '无 background-image'}`);
    } else {
      bgOk = true; // 从未设置过背景：placeholder 渐变属预期降级
    }

    /* ---- 人物断言 ---- */
    let charsOk = true;
    const renderedIds = snap.chars.map(c => c.id);
    for (const ec of expChars) {
      const r = snap.chars.find(c => c.id === ec.id);
      if (!r) { charsOk = false; problems.push(`角色 ${ec.id} 应出场但未渲染`); continue; }
      if (r.tag !== 'IMG' || !r.ok) { charsOk = false; problems.push(`角色 ${ec.id}(${ec.pos || 'free'}) 渲染为${r.tag === 'IMG' ? '加载失败的img ' + (r.src || '') : '剪影'}`); }
    }
    for (const r of snap.chars) {
      if (expChars.some(e => e.id === r.id)) continue;
      /* 额外渲染：仅当是本场 say 说话人自动补位时合规 */
      if (!actual.speakers.includes(r.id)) { charsOk = false; problems.push(`角色 ${r.id} 残留未清场（${r.where}）`); }
      else if (r.tag !== 'IMG' || !r.ok) { charsOk = false; problems.push(`自动补位角色 ${r.id} 渲染异常（${r.tag}）`); }
    }

    rows.push({
      target: label, scene: snap.sceneId + (jumped ? `（${want.id}→require跳转）` : ''),
      bg: bgOk ? (expBg === 'none' ? '纯黑✓' : expBg ? '✓' : '沿用·无') : '✗',
      chars: charsOk ? (expChars.length ? '✓×' + expChars.length : '空✓') : '✗',
      ok: bgOk && charsOk, note: problems.join('；')
    });
  }
}

/* ================= 主流程 ================= */
async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/index.html 不存在，先跑 python tools/build.py');
  if (!fs.existsSync(path.join(DIST_TEXT, 'index.html'))) throw new Error('dist_text/index.html 不存在，先跑 python tools/build_text_demo.py');

  const srvDist = spawn('python', ['-m', 'http.server', String(DIST_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(srvDist);
  const srvText = spawn('python', ['-m', 'http.server', String(TEXT_PORT), '--bind', '127.0.0.1'], { cwd: DIST_TEXT, stdio: 'ignore' });
  children.push(srvText);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DIST_PORT}/index.html`)).ok, 10000, 'dist http.server 就绪');
  await waitFor(async () => (await fetch(`http://127.0.0.1:${TEXT_PORT}/index.html`)).ok, 10000, 'dist_text http.server 就绪');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-disp-'));
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
  await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails;
    pageErrors.push('未捕获异常: ' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
  });

  const rows = [];
  await auditTarget('山间灯火', `http://127.0.0.1:${DIST_PORT}`, rows);
  await auditTarget('灯下问仙', `http://127.0.0.1:${TEXT_PORT}`, rows);

  /* ---- 压力用例：表情切换的 150ms 淡出计时器 vs 立即清场 ----
     updateChars 同位同角色换表情时会延迟 150ms 重渲染；若期间场景清空人物，
     过期计时器不得把已清场角色重新渲染出来。 */
  const firstCid = await ev(`Object.keys(script.characters)[0]`);
  for (const mode of ['slot', 'free']) {
    const mk = sprite => mode === 'slot'
      ? [{ id: firstCid, pos: 'center', sprite }]
      : [{ id: firstCid, x: 0.5, y: 1, sprite }];
    await ev(`updateChars(${JSON.stringify(mk('normal'))})`);
    await sleep(400);
    await ev(`updateChars(${JSON.stringify(mk('smile'))}); updateChars([]);`);
    await sleep(400);
    const snap = await ev(SNAPSHOT_JS);
    const ok = snap.chars.length === 0;
    rows.push({
      target: '压力', scene: `表情切换150ms内清场(${mode})`,
      bg: '-', chars: ok ? '空✓' : '✗', ok,
      note: ok ? '' : `清场后仍渲染: ${snap.chars.map(c => c.id + '@' + c.where + ':' + c.sprite).join(', ')}`
    });
  }
  /* 压力用例 2：快速连切场景，最终渲染必须与最后一场景一致 */
  await ev(`(() => {
    const scs = script.scenes;
    enterScene(1); enterScene(2); enterScene(3);
  })()`);
  await waitFor(() => ev(SETTLED_JS), 6000, '连切后渲染稳定');
  await sleep(200);
  const snap3 = await ev(SNAPSHOT_JS);
  const sc3 = await ev(`JSON.stringify((script.scenes[3].chars || []).map(c => c.id))`).then(JSON.parse);
  const ids3 = [...new Set(snap3.chars.map(c => c.id))].sort();
  const ok3 = JSON.stringify(ids3) === JSON.stringify([...sc3].sort())
    && snap3.chars.every(c => c.tag === 'IMG' && c.ok) && snap3.bg && !snap3.bg.placeholder && snap3.bg.ok === true;
  rows.push({
    target: '压力', scene: '快速连切3场景→最终一致',
    bg: snap3.bg && !snap3.bg.placeholder && snap3.bg.ok ? '✓' : '✗', chars: ok3 ? '✓' : '✗', ok: ok3,
    note: ok3 ? '' : `实际=${JSON.stringify(snap3.chars.map(c => c.id + ':' + c.tag + (c.ok ? '' : '!load')))} 预期=${JSON.stringify(sc3)} bg=${JSON.stringify(snap3.bg)}`
  });

  console.log('\n================ 全场景显示审计 ================');
  console.log('目标     | 场景                              | 背景       | 人物  ');
  console.log('---------|-----------------------------------|------------|-------');
  let pass = 0;
  for (const r of rows) {
    console.log(`${r.target.padEnd(8)} | ${r.scene.padEnd(33)} | ${String(r.bg).padEnd(10)} | ${r.chars}${r.note ? '\n         ↳ ' + r.note : ''}`);
    if (r.ok) pass++;
  }
  console.log('----------------------------------------------');
  console.log(`${pass}/${rows.length} 场景通过；页面未捕获异常 ${pageErrors.length} 条`);
  [...new Set(pageErrors)].slice(0, 10).forEach(e => console.log('  ' + e));
  cleanup();
  process.exit(pass === rows.length ? 0 : 1);
}

main().catch(e => { console.error('显示审计运行失败:', e); cleanup(); process.exit(2); });
