#!/usr/bin/env node
/* ============================================================================
 * e2e_sprite_check.mjs —— AI 生成结果的人物/背景显示保障专项验证
 *
 * 仿 tools/e2e_test.mjs 用例 11：mock chat API → AI 生成全流程 → 逐场景断言
 * 每个站位角色的立绘 <img> naturalWidth > 0（含 say.who 自动补位、套装缺表情
 * 回退 normal、mo_shy 保留），并断言背景多样性。
 *
 * 伺服现有 dist（不重建），端口 8127/9227 防冲突。改过的 ai_gen.js/tsc.js
 * 需先手动拷入 dist/ 再跑本脚本。
 *
 * 用法：node tools/e2e_sprite_check.mjs
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8127);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9227);
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const children = [];
function killTree(proc) {
  if (!proc || proc.killed) return;
  try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { proc.kill('SIGKILL'); } catch {} }
}
function cleanup() { for (const p of children.splice(0)) killTree(p); }
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
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

let cdp = null;
async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception;
    throw new Error('页面求值失败: ' + (d && d.description ? d.description.split('\n')[0] : r.exceptionDetails.text));
  }
  return r.result.value;
}
const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const visible = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!(e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none'); })()`);

let failed = 0;
function ok(cond, name, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '　' + detail : ''));
  if (!cond) failed++;
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/index.html 不存在');
  // 确认 dist 里的 ai_gen.js 已是新版本（含自动补位逻辑）
  const distSrc = fs.readFileSync(path.join(DIST, 'ai_gen.js'), 'utf8');
  if (!distSrc.includes('未列入 chars 站位，已自动补入'))
    throw new Error('dist/ai_gen.js 不是新版本，先手动拷贝 ai_gen.js 到 dist/');

  const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(BASE + '/index.html')).ok, 10000, 'http.server 就绪');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-sprite-'));
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(edge);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, 15000, 'Edge CDP 就绪');

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.on('Page.javascriptDialogOpening', () => {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  await cdp.send('Page.navigate', { url: BASE + '/' });
  await waitFor(() => ev(`document.readyState === 'complete'`), 20000, '页面加载完成');
  await sleep(1200);
  ok(await ev(`typeof window.AutoNovel === 'object' && typeof window.AutoNovel.open === 'function'`),
    '1. 页面加载，AutoNovel 存在');

  /* mock API：4 场景剧本，覆盖 自动补位 / 缺表情回退 / mo_shy 保留 / 空 chars */
  await ev(`(() => {
    const OUTLINE = { acts: [{ id: 'act1', title: '修仙一夜', scenes: [
      { id: 's1', summary: '竹林初遇', background: 'bg/bamboo.jpg', chars: ['c1'], checkpoint: true },
      { id: 's2', summary: '竹林夜谈', background: 'bg/bamboo2.jpg', chars: ['c1', 'c2'] },
      { id: 's3', summary: '雨夜茶棚', background: 'bg/tea.jpg', chars: ['c4'] },
      { id: 's4', summary: '渡口结局', background: 'bg/ferry.jpg', chars: ['c2'] },
    ], flags_introduced: [] }], endings: [{ label: '结局·归隐', condition: '' }] };
    const SCENES = [
      { id: 's1', background: 'bg/bamboo.jpg', checkpoint: true,
        chars: [{ id: 'c1', pos: 'center', sprite: 'normal' }],
        script: [
          { type: 'narrate', text: '竹林晨雾未散。' },
          { type: 'say', who: 'c1', text: '你来了。' },
          { type: 'say', who: 'c2', text: '我虽没站位，也该被看见。' },
          { type: 'goto', target: 's2' } ] },
      { id: 's2', background: 'bg/bamboo2.jpg',
        chars: [{ id: 'c1', pos: 'left', sprite: 'smile' }, { id: 'c2', pos: 'right', sprite: 'angry' },
                { id: 'c3', pos: 'center', sprite: 'laugh' }],
        script: [
          { type: 'say', who: 'c3', text: '我的 laugh 表情套装里没有。' },
          { type: 'say', who: 'c2', text: '夜谈至此。' },
          { type: 'goto', target: 's3' } ] },
      { id: 's3', background: 'bg/tea.jpg',
        chars: [{ id: 'c4', pos: 'center', sprite: 'shy' }],
        script: [
          { type: 'say', who: 'c4', text: '人家害羞嘛。' },
          { type: 'say', who: 'c1', text: '我也没站位。' },
          { type: 'goto', target: 's4' } ] },
      { id: 's4', background: 'bg/ferry.jpg',
        chars: [],
        script: [
          { type: 'say', who: 'c2', text: '空 chars 场景也能说话。' },
          { type: 'narrate', text: '渡船远去。' },
          { type: 'end', label: '结局·归隐' } ] } ];
    window.__origFetch = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).indexOf('chat/completions') < 0) return window.__origFetch(url, opts);
      const prompt = JSON.parse(opts.body).messages.map(m => m.content).join('\\n');
      const payload = prompt.indexOf('分幕大纲') >= 0 ? OUTLINE : { scenes: SCENES };
      const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\\n\\ndata: [DONE]\\n\\n';
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    };
  })()`);

  /* 打开 AI 生成，填 4 个角色，生成 */
  await click('#btn-ai-gen');
  await waitFor(() => visible('#an-form'), 5000, 'AI 生成表单');
  await click('#an-add-char'); await click('#an-add-char');
  await ev(`(() => {
    const names = document.querySelectorAll('.an-char-name'), descs = document.querySelectorAll('.an-char-desc');
    const data = [['苏', '温柔'], ['沈', '清冷'], ['棠', '活泼'], ['莫', '腼腆']];
    data.forEach((d, i) => { names[i].value = d[0]; descs[i].value = d[1]; });
  })()`);
  await ev(`document.getElementById('an-theme').value = 'mock修仙一夜'`);
  await ev(`document.getElementById('an-key').value = 'mock-key'`);
  await click('#an-generate');
  await waitFor(() => visible('#an-done'), 60000, '生成完成面板');
  const logText = await ev(`document.getElementById('an-log').textContent`);
  ok(/自动补入/.test(logText), '2. 生成日志含「自动补入」告警');
  ok(/回退 normal/.test(logText), '3. 生成日志含「回退 normal」（c3 laugh 不存在）');
  ok(/校验通过/.test(logText), '4. 校验通过');

  /* 开玩，拿到引擎里的 script 做逐场景断言 */
  await click('#an-play');
  await sleep(500);
  if (await visible('#name-input-overlay')) {
    await ev(`document.getElementById('name-input-field').value = '验证员'`);
    await click('#name-input-confirm');
  }
  await waitFor(async () => (await ev(`document.getElementById('dlgtext').textContent.length`)) > 0, 8000, '首条对话');

  const audit = await ev(`(async () => {
    const out = { scenes: script.scenes.length, bgs: [], bad: [], fill: {}, shyKept: false, laughReset: false };
    for (const sc of script.scenes) {
      out.bgs.push(sc.background);
      for (const c of sc.chars || []) {
        const p = spritePath(c.id, c.sprite || 'normal');
        if (!p) { out.bad.push(sc.id + '/' + c.id + ':spritePath=null'); continue; }
        const good = await new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false); i.src = (script.assets_dir || 'assets/') + p; });
        if (!good) out.bad.push(sc.id + '/' + c.id + ':' + p);
      }
    }
    out.fill.s1 = script.scenes[0].chars.map(c => c.id);
    out.fill.s4 = script.scenes[3].chars.map(c => c.id);
    out.shyKept = script.scenes[2].chars[0].sprite === 'shy';
    out.laughReset = script.scenes[1].chars[2].sprite === 'normal';
    return out;
  })()`);
  ok(audit.bad.length === 0, '5. 逐场景站位立绘全部加载成功（naturalWidth>0）',
    audit.bad.length ? audit.bad.join(',') : audit.scenes + ' 场景全绿');
  ok(audit.fill.s1.includes('c2'), '6. s1 的 say.who=c2 已自动补入 chars', JSON.stringify(audit.fill.s1));
  ok(audit.fill.s4.length > 0, '7. s4 空 chars 场景已补入说话角色', JSON.stringify(audit.fill.s4));
  ok(audit.shyKept, '8. c4(mo) 的 shy 表情保留（mo_shy.webp 真实存在）');
  ok(audit.laughReset, '9. c3(tang) 的 laugh 已回退 normal');
  ok(new Set(audit.bgs).size >= 3, '10. 4 场景背景 ' + new Set(audit.bgs).size + ' 种（≥3）',
    audit.bgs.map(b => b.split('/').pop()).join(','));

  /* 实际渲染：首场景 .slot img 也要 naturalWidth>0 */
  const live = await ev(`[...document.querySelectorAll('.slot img')].map(i => ({ src: i.src.split('/').pop(), w: i.naturalWidth }))`);
  ok(live.length > 0 && live.every(x => x.w > 0), '11. 实机渲染 .slot img 全部 naturalWidth>0', JSON.stringify(live));

  console.log('------------------------------------------');
  console.log(failed ? failed + ' 项失败' : '全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('运行失败:', e.message); cleanup(); process.exit(2); });
