#!/usr/bin/env node
/* e2e_routes.mjs —— 全结局试玩机器人（发布门禁）
 * 对 dist/games/ 下每部游戏：
 *   1) 自然通关一次（从标题页开始，第一选项路线）
 *   2) 每个结局场景：强制满足其 require 条件 + 好感拉满，直接跳入并打到 end
 * 断言：所有结局场景都能真正打出结局画面，全程 0 页面错误。
 *
 * 用法: node tools/e2e_routes.mjs [games/qunxiang ...]（默认 dist/games 下全部）
 * 环境: E2E_BROWSER 指定浏览器可执行文件（默认本机 Edge；CI 用 chromium）
 */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8152);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9252);
const BROWSER = process.env.E2E_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ONLY = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const children = [];
function killTree(p) { if (!p || p.killed) return; try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { p.kill('SIGKILL'); } catch {} } }
function cleanup() { if (process.env.E2E_KEEP) return; for (const p of children.splice(0)) killTree(p); }
process.on('exit', cleanup);
const isWin = process.platform === 'win32';
function cleanupUnix() { if (process.env.E2E_KEEP) return; for (const p of children.splice(0)) { try { p.kill('SIGKILL'); } catch {} } }
const realCleanup = isWin ? cleanup : cleanupUnix;

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('超时: ' + what); await sleep(250); }
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
async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('求值失败: ' + ((r.exceptionDetails.exception || {}).description || '').split('\n')[0]);
  return r.result.value;
}

/* 自动推进一帧；返回状态 */
async function stepState() {
  const st = await ev(`(() => {
    if (!document.getElementById('end-screen').classList.contains('hidden'))
      return { t: 'end', label: (document.getElementById('end-label') || {}).textContent || 'END' };
    if (document.getElementById('inspect-skip')) return { t: 'insp' };
    if (!document.getElementById('viewlayer').classList.contains('hidden')) return { t: 'view' };
    if (!document.getElementById('cglayer').classList.contains('hidden')) return { t: 'cg' };
    if (!document.getElementById('check-layer').classList.contains('hidden')) return { t: 'check' };
    if (document.querySelector('#choices .choice-btn:not(.disabled)')) return { t: 'choice' };
    if (document.querySelector('#choices .choice-btn')) return { t: 'locked' };
    return { t: 'dlg' };
  })()`);
  if (st.t === 'insp') await ev(`document.getElementById('inspect-skip').click()`);
  else if (st.t === 'view') await ev(`document.getElementById('viewlayer').click()`);
  else if (st.t === 'cg') await ev(`document.getElementById('cglayer').click()`);
  else if (st.t === 'check') await ev(`finishCheck()`);
  else if (st.t === 'choice') await ev(`document.querySelector('#choices .choice-btn:not(.disabled)').click()`);
  else if (st.t === 'dlg') await ev(`document.getElementById('dlg').click()`);
  await sleep(70);
  return st.t;
}

async function playToEnd(maxSteps) {
  for (let i = 0; i < maxSteps; i++) {
    const t = await stepState();
    if (t === 'end') return true;
    if (t === 'locked') return false;
  }
  return false;
}

/* 解析 require 表达式里的 == 条件并强制满足 */
async function forceRequire(sid) {
  await ev(`(() => {
    const s = script.scenes.find(x => x.id === ${JSON.stringify(sid)});
    if (s && s.require) {
      String(s.require).split('&&').forEach(part => {
        const m = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\\s*(==|>=|<=|>|<|!=)\\s*(\\d+)$/);
        if (m) {
          const v = parseInt(m[3], 10);
          if (m[2] === '==') vars[m[1]] = v;
          else if (m[2] === '>=' || m[2] === '>') vars[m[1]] = v + 5;
          else if (m[2] === '<=' || m[2] === '<') vars[m[1]] = Math.max(0, v - 5);
          else if (m[2] === '!=') vars[m[1]] = v + 1;
        }
      });
    }
    /* 好感类属性拉满，防路线内条件选项锁死 */
    Object.keys(script.attrs || {}).forEach(k => { if (/favor|好感/.test(k + ((script.attrs[k] || {}).name || ''))) vars[k] = 99; });
  })()`);
}

async function main() {
  const gamesRoot = path.join(DIST, 'games');
  let games = ONLY.length ? ONLY : (fs.existsSync(gamesRoot) ? fs.readdirSync(gamesRoot).map(d => 'games/' + d) : []);
  games = games.filter(g => fs.existsSync(path.join(DIST, g, 'index.html')));
  if (!games.length) { console.log('dist/games 下没有游戏变体，跳过'); return; }

  const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${HTTP_PORT}/index.html`)).ok, 10000, 'server');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-'));
  const browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', 'about:blank'], { stdio: 'ignore' });
  children.push(browser);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 15000, '浏览器 CDP');
  const page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page');
  cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  cdp.on('Runtime.exceptionThrown', p => errors.push('异常: ' + ((p.exceptionDetails.exception || {}).description || '').split('\n')[0]));

  const results = [];
  for (const g of games) {
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/${g}/` });
    await waitFor(() => ev(`document.readyState === 'complete'`), 20000, g + ' 加载');
    await sleep(1200);
    const title = await ev(`document.getElementById('game-title').textContent`);

    /* 1) 自然通关 */
    await ev(`document.getElementById('btn-start').click()`);
    await sleep(300);
    if (await ev(`!document.getElementById('name-input-overlay').classList.contains('hidden')`)) {
      await ev(`document.getElementById('name-input-field').value='机器人'`);
      await ev(`document.getElementById('name-input-confirm').click()`);
    }
    await sleep(800);
    const natural = await playToEnd(300);

    /* 2) 每个结局场景强制跳入 */
    const endScenes = await ev(`script.scenes.filter(s => s.script.some(c => c.type === 'end')).map(s => s.id)`);
    const perEnd = [];
    for (const sid of endScenes) {
      await ev(`loadScript(EMBEDDED_SCRIPT)`);
      await sleep(200);
      await forceRequire(sid);
      await ev(`enterScene(script.scenes.findIndex(s => s.id === ${JSON.stringify(sid)}))`);
      await sleep(400);
      const ok = await playToEnd(120);
      perEnd.push({ sid, ok });
    }
    const failed = perEnd.filter(x => !x.ok).map(x => x.sid);
    results.push({ g, title, natural, total: endScenes.length, failed });
  }

  console.log('\n========== 全结局试玩结果 ==========');
  let allOk = true;
  for (const r of results) {
    const ok = r.natural && r.failed.length === 0;
    if (!ok) allOk = false;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.g}（${r.title}）自然通关=${r.natural}，结局 ${r.total} 个${r.failed.length ? '，打不出: ' + r.failed.join(',') : '，全部可达成'}`);
  }
  console.log('页面错误:', errors.length, [...new Set(errors)].slice(0, 5).join(' / '));
  realCleanup();
  process.exit(allOk && errors.length === 0 ? 0 : 1);
}
main().catch(e => { console.error('运行失败:', e); realCleanup(); process.exit(2); });
