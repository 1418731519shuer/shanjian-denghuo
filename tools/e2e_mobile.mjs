#!/usr/bin/env node
/* e2e_mobile.mjs —— 移动端布局与触屏手势实测（390×844 手机竖屏模拟）
 * 用法：node tools/e2e_mobile.mjs   零依赖，node v22 原生 WebSocket CDP。
 * 覆盖：标题按钮不溢出 / 对话框高度 / 选项与菜单按钮 ≥44px / 上滑开回看、下滑开菜单 / 编辑器可打开 */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8131);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9231);
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const children = [];
function killTree(p) {
  if (!p || p.killed) return;
  try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { p.kill('SIGKILL'); } catch {} }
}
function cleanup() { if (process.env.E2E_KEEP) return; for (const p of children.splice(0)) killTree(p); }
process.on('exit', cleanup);

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('等待超时: ' + what); await sleep(250); }
}

class CDP {
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url); const c = new CDP(ws);
      ws.onopen = () => res(c); ws.onerror = () => rej(new Error('ws 连接失败')); ws.onclose = () => c.closed = true;
    });
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.closed = false;
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }
      else (this.handlers.get(m.method) || []).forEach(fn => { try { fn(m.params); } catch {} });
    };
  }
  send(method, params = {}) {
    return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, fn) { (this.handlers.get(method) || this.handlers.set(method, []).get(method)).push(fn); }
}

let cdp = null;
const errors = [];
const results = [];
async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('求值失败: ' + ((r.exceptionDetails.exception || {}).description || '').split('\n')[0]);
  return r.result.value;
}
const visible = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!(e && !e.classList.contains('hidden')); })()`);
const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);

async function runCase(name, fn) {
  const mark = errors.length;
  try {
    const note = (await fn()) || '';
    const ne = errors.length - mark;
    results.push({ name, ok: ne === 0, note: ne ? 'console错误×' + ne + ': ' + errors[mark] : note });
  } catch (e) { results.push({ name, ok: false, note: e.message.split('\n')[0] }); }
}

/* 触屏滑动：从 (x,y1) 滑到 (x,y2) */
async function swipe(x, y1, y2) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y1 }] });
  const steps = 6;
  for (let i = 1; i <= steps; i++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y1 + (y2 - y1) * i / steps }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
}

async function main() {
  const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(BASE + '/index.html')).ok, 10000, 'http.server');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-m-'));
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  children.push(edge);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 15000, 'Edge CDP');
  const page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page');
  cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown', p => errors.push('未捕获异常: ' + ((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text || '').split('\n')[0]));
  cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') errors.push('console.error: ' + p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)); });

  /* 手机竖屏 390×844（iPhone 14 类）+ 触屏 */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await waitFor(() => ev(`document.readyState === 'complete'`), 20000, '页面加载');
  await sleep(1200);

  /* M1：标题页按钮全部在视口内且不溢出 */
  await runCase('M1. 标题页按钮全部可见且不溢出 390px 视口', async () => {
    const bad = await ev(`(() => {
      const out = [];
      for (const id of ['btn-start','btn-continue','btn-gallery','btn-endings','btn-ai-gen','btn-editor','btn-load-script','btn-text-demo']) {
        const e = document.getElementById(id);
        if (!e || e.classList.contains('hidden')) continue;
        const r = e.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.left < -1 || r.right > 391 || r.top < -1 || r.bottom > 845) out.push(id + '(' + Math.round(r.left) + ',' + Math.round(r.right) + ')');
      }
      return out;
    })()`);
    if (bad.length) throw new Error('溢出按钮: ' + bad.join(', '));
    const fs = await ev(`getComputedStyle(document.getElementById('game-title')).fontSize`);
    return '全部在视口内，标题字号 ' + fs;
  });

  /* 进游戏 */
  await runCase('M2. 开始游戏 → 对话框高度与字号正常', async () => {
    await click('#btn-start');
    await waitFor(() => visible('#name-input-overlay'), 5000, '命名弹窗');
    await ev(`document.getElementById('name-input-field').value = '手机党'`);
    await click('#name-input-confirm');
    await waitFor(async () => (await ev(`document.getElementById('dlgtext').textContent.length`)) > 0, 8000, '首条对话');
    const r = await ev(`(() => { const e = document.getElementById('dlg').getBoundingClientRect(); return { h: e.height, w: e.width }; })()`);
    if (r.h < 110) throw new Error('对话框太矮: ' + r.h);
    if (r.w > 391) throw new Error('对话框超宽: ' + r.w);
    return `对话框 ${Math.round(r.w)}×${Math.round(r.h)}`;
  });

  /* M3：选项按钮 ≥44px 触达面积 */
  await runCase('M3. 选项按钮触达面积 ≥44px', async () => {
    for (let i = 0; i < 80; i++) {
      if (await ev(`!!document.querySelector('#choices .choice-btn')`)) break;
      await click('#dlg'); await sleep(80);
    }
    const sizes = await ev(`[...document.querySelectorAll('#choices .choice-btn')].map(b => { const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })`);
    if (!sizes.length) throw new Error('80 步内未遇到选项');
    const tooSmall = await ev(`[...document.querySelectorAll('#choices .choice-btn')].filter(b => { const r = b.getBoundingClientRect(); return r.height < 40 || r.width < 40; }).length`);
    if (tooSmall) throw new Error('有按钮过小: ' + sizes.join(','));
    await click('#choices .choice-btn:not(.disabled)');
    return '选项尺寸 ' + sizes.join(', ');
  });

  /* M4：上滑开回看 */
  await runCase('M4. 上滑手势打开回看', async () => {
    await swipe(195, 600, 300);
    if (!(await visible('#history-panel'))) throw new Error('上滑后回看未打开');
    await click('#hist-close'); await sleep(400);
    return '上滑→回看打开';
  });

  /* M5：下滑开系统菜单，按钮 ≥44px */
  await runCase('M5. 下滑手势打开系统菜单，按钮 ≥44px', async () => {
    await swipe(195, 300, 620);
    if (!(await visible('#sys-menu'))) throw new Error('下滑后系统菜单未打开');
    const small = await ev(`[...document.querySelectorAll('#sys-menu .sysbtn, #sys-menu .btn')].filter(b => { const r = b.getBoundingClientRect(); return r.height < 40; }).length`);
    if (small) throw new Error('菜单按钮过小×' + small);
    await click('#sm-resume'); await sleep(300);
    return '下滑→菜单打开，按钮尺寸达标';
  });

  /* M6：编辑器在手机上可打开 */
  await runCase('M6. 编辑器在手机视口打开不报错', async () => {
    await click('#mb-title'); await waitFor(() => visible('#title-screen'), 5000, '回标题');
    await click('#btn-editor');
    await waitFor(() => visible('#scene-editor'), 5000, '编辑器打开');
    await sleep(500);
    const cards = await ev(`document.querySelectorAll('.se-scene-card').length`);
    if (cards < 1) throw new Error('无场景卡片');
    await click('#se-exit');
    await waitFor(() => visible('#title-screen'), 5000, '退出编辑器');
    return '场景卡片 ' + cards + ' 张';
  });

  console.log('\n=========== 移动端 E2E 结果 ===========');
  let pass = 0;
  for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? '\n      ' + r.note : ''}`); if (r.ok) pass++; }
  console.log('---------------------------------------');
  console.log(`${pass}/${results.length} 通过；页面错误 ${errors.length} 条`);
  cleanup();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch(e => { console.error('运行失败:', e); cleanup(); process.exit(2); });
