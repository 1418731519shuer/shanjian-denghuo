#!/usr/bin/env node
/* ============================================================================
 * e2e_ai_gen_panel.mjs —— AI 生成面板新功能专项验证（mock API，离线）
 *
 * 覆盖本次改动：
 *   1. 快速模板 chips ≥3，点「修仙悬疑」自动填题材 + 角色卡
 *   2. 「查看脚本示例」面板有内容（tsc.js DEMO 或内置精简版）
 *   3. mock API 走一遍生成 → 结果面板出现「自检摘要」统计行
 *
 * 伺服现有 dist（不重建），端口 8130/9230 防冲突。改过的 ai_gen.js
 * 需先手动拷入 dist/ 再跑本脚本（脚本会检查特征串）。
 *
 * 用法：node tools/e2e_ai_gen_panel.mjs
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8130);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9230);
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
  // 确认 dist 里的 ai_gen.js 已是新版本（含自检摘要行）
  const distSrc = fs.readFileSync(path.join(DIST, 'ai_gen.js'), 'utf8');
  if (!distSrc.includes('an-done-stats'))
    throw new Error('dist/ai_gen.js 不是新版本，先手动拷贝 ai_gen.js 到 dist/');

  const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(BASE + '/index.html')).ok, 10000, 'http.server 就绪');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-panel-'));
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

  /* 打开 AI 生成表单 */
  await click('#btn-ai-gen');
  await waitFor(() => visible('#an-form'), 5000, 'AI 生成表单');

  /* 1) 快速模板 chips */
  const chips = await ev(`[...document.querySelectorAll('#an-templates .an-chip')].map(c => c.textContent)`);
  ok(chips.length >= 3, '1. 快速模板 chips ≥3 个', chips.join('/'));
  const idx = chips.findIndex(c => c.includes('修仙'));
  await ev(`document.querySelectorAll('#an-templates .an-chip')[${idx}].click()`);
  const filled = await ev(`(() => {
    const theme = document.getElementById('an-theme').value;
    const names = [...document.querySelectorAll('#an-chars .an-char-name')].map(i => i.value);
    const descs = [...document.querySelectorAll('#an-chars .an-char-desc')].map(i => i.value);
    return { theme, names, descs };
  })()`);
  ok(!!filled.theme && filled.names.length >= 2 && filled.names.every(Boolean) && filled.descs.every(Boolean),
    '2. 点「修仙悬疑」自动填题材+角色卡', filled.theme + ' / ' + filled.names.join('、'));

  /* 2) 「查看脚本示例」面板 */
  const example = await ev(`document.getElementById('an-example-text').textContent`);
  ok(example.length > 50 && /==场景 /.test(example) && /::结局 /.test(example),
    '3. 示例面板有内容且为文字脚本格式', '长度=' + example.length +
    '，来源=' + (await ev(`!!(window.TextScript && window.TextScript.DEMO)`) ? 'tsc.js DEMO' : '内置精简版'));

  /* 3) mock API 走一遍生成，断言结果面板统计摘要行 */
  await ev(`(() => {
    const OUTLINE = { acts: [{ id: 'act1', title: '山门一夜', scenes: [
      { id: 's1_gate', summary: '雨夜山门发现尸体', background: 'bg/rain.jpg', chars: ['c1'], checkpoint: true },
      { id: 's_end_truth', summary: '结局·真相', background: 'bg/hall.jpg', chars: ['c1', 'c2'] },
    ], flags_introduced: [] }], endings: [{ label: '结局·真相', condition: '' }] };
    const SCENES = [
      { id: 's1_gate', background: 'bg/rain.jpg', checkpoint: true,
        chars: [{ id: 'c1', pos: 'left', sprite: 'normal' }],
        script: [
          { type: 'narrate', text: '雨夜，山门前躺着一具无名尸。' },
          { type: 'say', who: 'c1', text: '师兄，你看这里。' },
          { type: 'choice', options: [
            { text: '查下去', goto: 's_end_truth', set: { flag_clue: 1 } },
            { text: '报官', goto: 's_end_truth' } ] } ] },
      { id: 's_end_truth', background: 'bg/hall.jpg',
        chars: [{ id: 'c1', pos: 'left', sprite: 'normal' }, { id: 'c2', pos: 'right', sprite: 'surprise' }],
        script: [
          { type: 'say', who: 'c2', text: '凶手竟是……' },
          { type: 'end', label: '结局·真相' } ] } ];
    window.__origFetch = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).indexOf('chat/completions') < 0) return window.__origFetch(url, opts);
      const prompt = JSON.parse(opts.body).messages.map(m => m.content).join('\\n');
      const payload = prompt.indexOf('分幕大纲') >= 0 ? OUTLINE : { scenes: SCENES };
      const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\\n\\ndata: [DONE]\\n\\n';
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    };
  })()`);
  await ev(`document.getElementById('an-key').value = 'mock-key'`);
  await click('#an-generate');
  await waitFor(() => visible('#an-done'), 60000, '生成完成面板');
  const stats = await ev(`document.getElementById('an-done-stats').textContent`);
  ok(/自检摘要/.test(stats) && /校验通过/.test(stats) && /素材映射 \d+ 条/.test(stats),
    '4. 结果面板出现自检摘要统计行', stats);
  const hint = await ev(`(() => { const h = document.querySelector('#an-done .an-hint'); return h ? h.textContent : ''; })()`);
  ok(/下载剧本 JSON/.test(hint) && /文字脚本/.test(hint), '5. 结果面板提示 JSON 与文字脚本的关系');

  console.log('------------------------------------------');
  console.log(failed ? failed + ' 项失败' : '全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('运行失败:', e.message); cleanup(); process.exit(2); });
