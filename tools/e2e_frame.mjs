#!/usr/bin/env node
/* ============================================================================
 * e2e_frame.mjs —— 帧模式胶片条 + 站位系统 端到端测试
 * （真实 Edge headless + CDP，零依赖；基建复用自 e2e_editor.mjs）
 *
 * 用例：
 *   a. 帧模式渲染：第一场景帧卡数=指令数，帧卡内 img 全部加载成功
 *   b. 跳转 chip：goto 帧卡 chip 点击 → 场景网格改目标 → JSON 变化
 *   c. 悬空引用：goto 目标改不存在 → 帧卡出现红框类（dangling）
 *   d. 吸附：模拟拖自由位角色到 x≈0.29 → 保存值 x=0.28 且 y=1.0
 *   e. 参考线：5 条竖参考线存在且随编辑器隐藏
 *
 * 用法：node tools/e2e_frame.mjs   （前置：python tools/build.py）
 * 环境变量：E2E_EDGE / E2E_HTTP_PORT（默认 8133）/ E2E_CDP_PORT（默认 9233）/ E2E_KEEP=1
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8133);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9233);
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

/* ================= 主流程 ================= */
async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/index.html 不存在，先跑 python tools/build.py');

  const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(BASE + '/index.html')).ok, 10000, 'http.server 就绪');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-e2efr-'));
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

  const enterEditor = async () => {
    await click('#btn-editor');
    await waitFor(() => ev(`!document.getElementById('scene-editor').classList.contains('hidden')`), 5000, '编辑器打开');
    await sleep(600);
  };

  /* ---------- 用例 a：帧模式渲染（默认帧模式） ---------- */
  await runCase('a. 帧模式渲染：帧卡数=指令数，帧内图片全部加载', async () => {
    await enterEditor();
    const mode = await ev(`document.getElementById('se-timeline-wrap').classList.contains('frame-mode')`);
    if (!mode) throw new Error('默认不是帧模式');
    const nCmd = await ev(`script.scenes[0].script.length`);
    const nFr = await ev(`document.querySelectorAll('#tl-frames .tl-frame').length`);
    if (nFr !== nCmd) throw new Error(`帧卡数 ${nFr} ≠ 指令数 ${nCmd}`);
    const imgCheck = await ev(`(async () => {
      const imgs = [...document.querySelectorAll('#tl-frames .fr-shot img')];
      await Promise.all(imgs.map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })));
      const bad = imgs.filter(i => !(i.naturalWidth > 0)).map(i => i.src.split('/').pop());
      return { total: imgs.length, bad };
    })()`);
    if (imgCheck.bad.length) throw new Error('帧内图片未加载: ' + imgCheck.bad.join(','));
    return `帧卡 ${nFr}/${nCmd}，图片×${imgCheck.total} 全部加载（背景+立绘合成）`;
  });

  /* ---------- 用例 b：goto 帧卡 chip 改目标 ---------- */
  await runCase('b. 跳转 chip：goto 帧卡 chip → 场景网格改目标 → JSON 变化', async () => {
    /* 找一个 goto 指令；主剧本没有就现场注入一个 */
    const loc = await ev(`(() => {
      for (let si = 0; si < script.scenes.length; si++) {
        const ci = script.scenes[si].script.findIndex(c => c.type === 'goto' && c.target);
        if (ci >= 0) return { si, ci, injected: false };
      }
      script.scenes[0].script.push({ type: 'goto', target: 's1_tea' });
      return { si: 0, ci: script.scenes[0].script.length - 1, injected: true };
    })()`);
    await ev(`selectEditorScene(${loc.si})`);
    await sleep(300);
    const before = await ev(`script.scenes[${loc.si}].script[${loc.ci}].target`);
    await click(`.tl-frame[data-idx="${loc.ci}"] .fr-chip`);
    await waitFor(() => ev(`!!document.querySelector('.se-grid-pop')`), 5000, '场景网格弹出');
    const picked = await ev(`(() => {
      const cells = [...document.querySelectorAll('.se-grid-pop .se-grid-cell')];
      const c = cells.find(x => x.dataset.value && x.dataset.value !== ${JSON.stringify(before || '')});
      if (!c) return null;
      c.click();
      return c.dataset.value;
    })()`);
    if (!picked) throw new Error('场景网格无可选目标');
    await sleep(200);
    const after = await ev(`script.scenes[${loc.si}].script[${loc.ci}].target || ''`);
    if (after !== picked || after === before) throw new Error(`goto 未变化：${before} → ${after}（点选 ${picked}）`);
    const chipText = await ev(`document.querySelector('.tl-frame[data-idx="${loc.ci}"] .fr-chip').textContent`);
    if (!chipText.includes(picked)) throw new Error('chip 未回显新目标: ' + chipText);
    return `goto ${before} → ${after}${loc.injected ? '（注入的 goto）' : ''}，chip 回显「${chipText}」`;
  });

  /* ---------- 用例 c：悬空引用红框 ---------- */
  await runCase('c. 悬空引用：goto 目标不存在 → 帧卡红框 dangling', async () => {
    const loc = await ev(`(() => {
      for (let si = 0; si < script.scenes.length; si++) {
        const ci = script.scenes[si].script.findIndex(c => c.type === 'goto');
        if (ci >= 0) return { si, ci, orig: script.scenes[si].script[ci].target };
      }
      return null;
    })()`);
    if (!loc) throw new Error('没有 goto 指令可测');
    await ev(`(() => { script.scenes[${loc.si}].script[${loc.ci}].target = 'ghost_scene_x'; selectEditorScene(${loc.si}); })()`);
    await sleep(300);
    const dang = await ev(`(() => {
      const fr = document.querySelector('.tl-frame[data-idx="${loc.ci}"]');
      return fr ? { has: fr.classList.contains('dangling'), title: fr.title || '' } : null;
    })()`);
    if (!dang || !dang.has) throw new Error('帧卡未加 dangling 红框类');
    if (!/ghost_scene_x/.test(dang.title)) throw new Error('title 缺悬空提示: ' + dang.title);
    /* 还原：改回合法目标，红框应消失 */
    await ev(`(() => { script.scenes[${loc.si}].script[${loc.ci}].target = ${JSON.stringify(loc.orig || 's1_tea')}; selectEditorScene(${loc.si}); })()`);
    await sleep(300);
    const still = await ev(`document.querySelector('.tl-frame[data-idx="${loc.ci}"]').classList.contains('dangling')`);
    if (still) throw new Error('还原后红框未消失');
    return `dangling 红框出现（title 含 ghost_scene_x），还原后消失`;
  });

  /* ---------- 用例 d：拖拽吸附（x≈0.29 → 0.28，y=1.0） ---------- */
  await runCase('d. 吸附：拖自由位角色到 x≈0.29 → 保存 x=0.28 且 y=1.0', async () => {
    /* 确保场景 0 有自由位角色（没有就注入） */
    await ev(`(() => {
      selectEditorScene(0);
      if (!(script.scenes[0].chars || []).some(c => c.x !== undefined)) {
        script.scenes[0].chars = [{ id: Object.keys(script.characters)[0], x: 0.5, y: 1, scale: 1, sprite: 'normal', effect: 'fade' }];
        selectEditorScene(0);
      }
    })()`);
    await sleep(300);
    const geo = await ev(`(() => {
      const el = document.querySelector('.se-ed-char');
      const cv = document.getElementById('se-canvas-wrap').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2,
               tx: cv.left + 0.29 * cv.width, ty: cv.top + 0.9 * cv.height };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.cx, y: geo.cy, button: 'left', clickCount: 1 });
    for (let s = 1; s <= 5; s++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
        x: geo.cx + (geo.tx - geo.cx) * s / 5, y: geo.cy + (geo.ty - geo.cy) * s / 5 });
      await sleep(40);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.tx, y: geo.ty, button: 'left', clickCount: 1 });
    await sleep(500);
    const saved = await ev(`(() => { const c = script.scenes[0].chars.find(c => c.x !== undefined); return c ? { x: c.x, y: c.y } : null; })()`);
    if (!saved) throw new Error('自由位角色丢失');
    if (saved.x !== 0.28 || saved.y !== 1.0) throw new Error(`吸附失败: x=${saved.x}（期望 0.28）y=${saved.y}（期望 1.0）`);
    return `拖到 x≈0.29 → 吸附 x=${saved.x}, y=${saved.y}`;
  });

  /* ---------- 用例 e：参考线存在且仅编辑器可见 ---------- */
  await runCase('e. 参考线：5 条竖线在画布内，退出编辑器即不可见', async () => {
    const n = await ev(`document.querySelectorAll('#se-canvas-wrap > #se-guides .se-guide-v').length`);
    if (n !== 5) throw new Error('竖参考线数量=' + n + '（期望 5）');
    const base = await ev(`!!document.querySelector('#se-guides .se-guide-base')`);
    if (!base) throw new Error('缺底部人物底线');
    const xs = await ev(`[...document.querySelectorAll('.se-guide-v')].map(v => v.dataset.x).join(',')`);
    if (xs !== '0.1,0.28,0.5,0.72,0.9') throw new Error('参考线位置不符: ' + xs);
    await ev(`exitEditor()`);
    await sleep(300);
    const disp = await ev(`getComputedStyle(document.getElementById('scene-editor')).display`);
    if (disp !== 'none') throw new Error('退出后编辑器仍可见: ' + disp);
    return `5 条竖线（${xs}）+底线，exitEditor 后随编辑器隐藏`;
  });

  /* ================= 汇总 ================= */
  console.log('\n================ E2E（帧模式/站位）结果 ================');
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
