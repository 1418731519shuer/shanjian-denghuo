#!/usr/bin/env node
/* ============================================================================
 * e2e_test.mjs —— 视觉小说 PWA 端到端运行测试（真实 Edge headless + CDP，零依赖）
 *
 * 用法：node tools/e2e_test.mjs
 *   自动完成：启动 python http.server 伺服 dist/ → 启动 headless Edge（远程调试端口）
 *   → 通过 CDP（原生 WebSocket）驱动页面跑 10 个用例 → 打印结果 → 清理进程。
 *
 * 环境变量可覆盖默认值：
 *   E2E_EDGE      Edge 可执行文件路径
 *   E2E_HTTP_PORT http.server 端口（默认 8123）
 *   E2E_CDP_PORT  CDP 调试端口（默认 9223）
 *   E2E_KEEP=1    结束后不杀进程（调试用）
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8123);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9223);
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
      ws.onerror = e => reject(new Error('WebSocket 连接失败'));
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
const errors = [];          // 页面 console error / 未捕获异常 / Log error
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

/* 推进一条：根据当前等待状态点击对话框/选项/调查点/CG层。返回状态。 */
async function step() {
  const st = await ev(`(() => {
    const vis = id => { const e = document.getElementById(id); return !!(e && !e.classList.contains('hidden')); };
    if (vis('end-screen')) return { t: 'end' };
    if (vis('viewlayer')) return { t: 'view' };
    if (vis('cglayer')) return { t: 'cg' };
    const hs = document.querySelector('#hotspots .hotspot');
    if (hs) return { t: 'inspect' };
    const ch = document.querySelector('#choices .choice-btn:not(.disabled)');
    if (ch) return { t: 'choice', n: document.querySelectorAll('#choices .choice-btn').length };
    return { t: 'dlg', text: document.getElementById('dlgtext').textContent.slice(0, 20) };
  })()`);
  if (st.t === 'choice') await click('#choices .choice-btn:not(.disabled)');
  else if (st.t === 'inspect') { await click('#hotspots .hotspot'); await sleep(150); if (await visible('#viewlayer')) await click('#viewlayer'); }
  else if (st.t === 'view') await click('#viewlayer');
  else if (st.t === 'cg') await click('#cglayer');
  else if (st.t === 'dlg') await click('#dlg');
  return st.t;
}

/* 推进，直到 dlg 步数达到 n；遇选项/调查点自动处理。返回统计。 */
async function advanceDlg(n, maxIter = 200) {
  let dlg = 0, choices = 0, ended = false;
  for (let i = 0; i < maxIter && dlg < n; i++) {
    const t = await step();
    if (t === 'dlg') dlg++;
    else if (t === 'choice') choices++;
    else if (t === 'end') { ended = true; break; }
    await sleep(90);
  }
  return { dlg, choices, ended };
}

/* ================= 主流程 ================= */
async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/index.html 不存在，先跑 python tools/build.py');

  /* 启动 http.server */
  const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(BASE + '/index.html')).ok, 10000, 'http.server 就绪');

  /* 启动 headless Edge */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-e2e-'));
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

  const gotoReady = async url => {
    await cdp.send('Page.navigate', { url });
    await waitFor(() => ev(`document.readyState === 'complete'`), 20000, '页面加载完成');
    await sleep(1200);
  };

  /* ---------- 用例 1：页面加载无错误，ai_gen.js 加载成功 ---------- */
  await runCase('1. 页面加载无 console error，AutoNovel 存在', async () => {
    await gotoReady(BASE + '/');
    const ai = await ev(`typeof window.AutoNovel === 'object' && typeof window.AutoNovel.open === 'function'`);
    if (!ai) throw new Error('window.AutoNovel.open 不存在（ai_gen.js 加载失败？）');
    const title = await ev(`document.getElementById('game-title').textContent`);
    if (!title || title === '…') throw new Error('标题未渲染');
    return '标题=' + title;
  });

  /* ---------- 用例 2：标题页渲染 + 粒子动画 ---------- */
  await runCase('2. 标题页按钮齐全，粒子 canvas 在运行', async () => {
    for (const id of ['btn-start', 'btn-continue', 'btn-gallery', 'btn-endings', 'btn-ai-gen', 'btn-editor'])
      if (!(await ev(`!!document.getElementById('${id}')`))) throw new Error('缺按钮 #' + id);
    for (const id of ['btn-start', 'btn-gallery', 'btn-endings', 'btn-ai-gen', 'btn-editor'])
      if (!(await visible('#' + id))) throw new Error('按钮不可见 #' + id);
    const shot = () => ev(`(() => {
      const c = document.getElementById('title-particles');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let s = 0; for (let i = 0; i < d.length; i += 4049) s = (s * 31 + d[i]) >>> 0;
      return c.width + 'x' + c.height + ':' + s;
    })()`);
    const a = await shot(); await sleep(700); const b = await shot();
    if (a === b) throw new Error('粒子 canvas 两帧相同，动画未运行 (' + a + ')');
    return '帧指纹 ' + a + ' → ' + b;
  });

  /* ---------- 用例 3：开始游戏 → 命名 → 首场景背景/打字机/推进15条 ---------- */
  await runCase('3. 开始游戏→命名→背景加载→打字机推进15条', async () => {
    await click('#btn-start');
    await waitFor(() => visible('#name-input-overlay'), 5000, '命名弹窗出现');
    await ev(`(() => { const f = document.getElementById('name-input-field'); f.value = '测试员'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('#name-input-confirm');
    await waitFor(async () => (await ev(`document.getElementById('dlgtext').textContent.length`)) > 0, 8000, '首条对话出现');
    const bg = await ev(`(async () => {
      const el = [...document.querySelectorAll('.bg')].find(e => e.classList.contains('on'));
      if (!el) return { ok: false, url: null };
      const m = getComputedStyle(el).backgroundImage.match(/url\\("?(.*?)"?\\)/);
      if (!m || m[1] === 'none') return { ok: false, url: null };
      return await new Promise(res => { const i = new Image(); i.onload = () => res({ ok: i.naturalWidth > 0, url: m[1], w: i.naturalWidth }); i.onerror = () => res({ ok: false, url: m[1] }); i.src = m[1]; });
    })()`);
    if (!bg.ok) throw new Error('背景图未加载成功: ' + bg.url);
    const r = await advanceDlg(15);
    if (r.dlg < 15) throw new Error(`只推进了 ${r.dlg} 条对话（选项×${r.choices}${r.ended ? '，已到结局' : ''}）`);
    return `背景 ${path.basename(bg.url)} ${bg.w}px，推进 ${r.dlg} 条，途中选项×${r.choices}`;
  });

  /* ---------- 用例 4：遇选项点击后继续推进 10 条 ---------- */
  await runCase('4. 点击选项后继续推进 10 条', async () => {
    /* 用例 3 可能已点掉首个选项；继续推进直到再遇到一个选项（上限 60 步） */
    let hit = false, ended = false;
    for (let i = 0; i < 60 && !hit; i++) {
      const t = await step();
      if (t === 'choice') hit = true;
      if (t === 'end') { ended = true; break; }
      await sleep(90);
    }
    if (!hit && ended) return '剧本已提前到结局（选项已在前序用例点过），跳过专项验证';
    if (!hit) throw new Error('60 步内未遇到选项');
    const r = await advanceDlg(10);
    if (r.dlg < 10 && !r.ended) throw new Error(`选项后只推进了 ${r.dlg} 条`);
    return `选项后推进 ${r.dlg} 条${r.ended ? '（已到结局）' : ''}`;
  });

  /* ---------- 用例 5：系统菜单/回看/CG画廊/结局收集/设置 ---------- */
  await runCase('5. 系统菜单、回看、CG画廊、结局收集、设置开合无错误', async () => {
    /* 游戏内：系统菜单 */
    await click('#mb-menu');
    if (!(await visible('#sys-menu'))) throw new Error('系统菜单未打开');
    await click('#sm-resume');
    /* 回看面板（此时应有历史记录） */
    await click('#mb-hist');
    if (!(await visible('#history-panel'))) throw new Error('回看面板未打开');
    const h = await ev(`document.getElementById('history-list').children.length`);
    if (h < 1) throw new Error('回看面板无记录');
    await click('#hist-close');
    /* 设置 */
    await click('#mb-set');
    if (!(await visible('#settings-panel'))) throw new Error('设置面板未打开');
    await click('#settings-panel [data-close]');
    /* 回标题开画廊/结局 */
    await click('#mb-title');
    await waitFor(() => visible('#title-screen'), 5000, '回到标题页');
    await click('#btn-gallery');
    if (!(await visible('#gallery-screen'))) throw new Error('CG画廊未打开');
    const cgN = await ev(`document.getElementById('gallery-grid').children.length`);
    await click('#gallery-screen [data-close]');
    await click('#btn-endings');
    if (!(await visible('#endings-screen'))) throw new Error('结局收集未打开');
    const edN = await ev(`document.getElementById('endings-list').children.length`);
    await click('#endings-screen [data-close]');
    return `回看 ${h} 条，画廊 ${cgN} 格，结局列表 ${edN} 项`;
  });

  /* ---------- 用例 6：F5 快速存档 / F9 快速读档 ---------- */
  await runCase('6. F5 快速存档 + F9 快速读档', async () => {
    await click('#btn-start');                    // 重新开始一局
    await waitFor(() => visible('#name-input-overlay'), 5000, '命名弹窗');
    await ev(`document.getElementById('name-input-field').value = '存档员'`);
    await click('#name-input-confirm');
    await waitFor(async () => (await ev(`document.getElementById('dlgtext').textContent.length`)) > 0, 8000, '对话出现');
    await advanceDlg(3);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }))`);
    await sleep(200);
    const savedPos = await ev(`(() => { const d = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('_save_quicksave')))); return d ? d.sceneIdx + ':' + d.lineIdx : null; })()`);
    if (!savedPos) throw new Error('F5 后 localStorage 无 quicksave');
    await advanceDlg(3);
    const before = await ev(`sceneIdx + ':' + lineIdx`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true }))`);
    await sleep(400);
    const after = await ev(`sceneIdx + ':' + lineIdx`);
    if (after !== savedPos) throw new Error(`F9 读档位置不符：存档 ${savedPos}，读档后 ${after}（读档前 ${before}）`);
    return `存档 ${savedPos} → 推进到 ${before} → 读档回 ${after}`;
  });

  /* ---------- 用例 7：BGM/SFX audio 元素创建且资源 200 ---------- */
  await runCase('7. BGM/SFX 元素创建，音频资源可访问', async () => {
    const info = await ev(`(() => ({ bgm: curAudio ? curAudio.src : null, cur: curBgm }))()`);
    if (!info.bgm) throw new Error('场景有 bgm 配置但 curAudio 为空（' + JSON.stringify(info.cur) + '）');
    const rel = decodeURIComponent(new URL(info.bgm).pathname).replace(/^\//, '');
    const resp = await fetch(`${BASE}/${rel}`, { method: 'HEAD' });
    if (resp.status !== 200) throw new Error(`BGM 资源 ${rel} 返回 ${resp.status}`);
    const sfxCfg = await ev(`(() => { const s = script.scenes.find(x => x.sfx); return s ? (Array.isArray(s.sfx) ? s.sfx : [s.sfx]).map(c => (c && c.src) || c) : []; })()`);
    for (const s of sfxCfg) {
      const r2 = await fetch(`${BASE}/assets/${s}`, { method: 'HEAD' });
      if (r2.status !== 200) throw new Error(`SFX 资源 assets/${s} 返回 ${r2.status}`);
    }
    return `BGM ${path.basename(rel)} 200，SFX×${sfxCfg.length} 均 200（无头不真播）`;
  });

  /* ---------- 用例 8：localStorage 存档/endings 键写入 ---------- */
  await runCase('8. localStorage 存档/进度键正常写入', async () => {
    const keys = await ev(`Object.keys(localStorage)`);
    const need = ['_save_quicksave', '_save_checkpoint', '_seen'];
    const missing = need.filter(s => !keys.some(k => k.endsWith(s)));
    if (missing.length) throw new Error('缺少键: ' + missing.join(', ') + '（现有: ' + keys.join(', ') + '）');
    const endingsKey = keys.find(k => k.endsWith('_endings'));
    return `键 ${keys.length} 个（${keys.map(k => k.replace(/^wenyou_.*?_/, '…_')).join(', ')}），endings=${endingsKey ? '存在' : '尚未达成结局（正常）'}`;
  });

  /* ---------- 用例 9：Service Worker 注册 ---------- */
  await runCase('9. Service Worker 注册成功', async () => {
    const reg = await waitFor(async () => {
      const r = await ev(`navigator.serviceWorker.getRegistration().then(r => r ? r.active ? 'active' : (r.installing || r.waiting ? 'installing' : 'empty') : null)`);
      return r === 'active' ? r : (r === 'installing' ? null : r);
    }, 15000, 'SW active').catch(() => null);
    if (!reg) {
      const state = await ev(`navigator.serviceWorker.getRegistration().then(r => r ? 'registered-not-active' : 'none')`);
      throw new Error('SW 未激活: ' + state);
    }
    return 'SW active，scope=' + await ev(`navigator.serviceWorker.getRegistration().then(r => r.scope)`);
  });

  /* ---------- 用例 10：场景编辑器打开/退出无错误 ---------- */
  await runCase('10. 场景编辑器打开渲染无错误并退出', async () => {
    if (!(await visible('#title-screen'))) {
      await ev(`document.getElementById('mb-title').click()`).catch(() => {});
      await sleep(300);
      if (!(await visible('#title-screen'))) await ev(`backToTitle()`);
      await waitFor(() => visible('#title-screen'), 5000, '回标题');
    }
    await click('#btn-editor');
    await waitFor(() => visible('#scene-editor'), 5000, '编辑器打开');
    await sleep(800);
    const cards = await ev(`document.querySelectorAll('.se-scene-card').length`);
    if (cards < 1) throw new Error('编辑器左侧无场景卡片');
    const blocks = await ev(`document.querySelectorAll('#se-timeline-wrap .tl-block').length`);
    await click('#se-exit');
    await waitFor(() => visible('#title-screen'), 5000, '退出编辑器回标题');
    return `场景卡片 ${cards}，时间轴块 ${blocks}`;
  });

  /* ---------- 用例 11：AI 生成全流程（mock API，免费离线验证管线） ---------- */
  await runCase('11. AI生成新故事（mock API）→ 生成→校验→映射→开玩', async () => {
    /* 劫持 fetch：识别 chat/completions，按 prompt 类型返回预制 SSE 流 */
    await ev(`(() => {
      const OUTLINE = { acts: [{ id: 'act1', title: '茶棚夜雨',
        scenes: [
          { id: 's1_start', summary: '雨夜茶棚初遇', background: 'bg/tea.jpg', chars: ['c1'], checkpoint: true },
          { id: 's_end_warm', summary: '结局·暖灯', background: 'bg/lantern.jpg', chars: ['c1', 'c2'] },
        ], flags_introduced: [] }],
        endings: [{ label: '结局·暖灯', condition: '' }] };
      const SCENES = [
        { id: 's1_start', background: 'bg/tea.jpg', checkpoint: true,
          chars: [{ id: 'c1', pos: 'center', sprite: 'normal' }],
          script: [
            { type: 'narrate', text: '雨敲茶棚，灯影摇晃。' },
            { type: 'say', who: 'c1', text: '客官，进来避避雨吧。' },
            { type: 'choice', options: [
              { text: '进棚喝茶', goto: 's_end_warm' },
              { text: '继续赶路', goto: 's_end_warm' } ] } ] },
        { id: 's_end_warm', background: 'bg/lantern.jpg',
          chars: [{ id: 'c1', pos: 'left', sprite: 'smile' }, { id: 'c2', pos: 'right', sprite: 'normal' }],
          script: [
            { type: 'say', who: 'c2', text: '这盏灯，给你留着。' },
            { type: 'narrate', text: '雨停了。' },
            { type: 'end', label: '结局·暖灯' } ] } ];
      window.__mock402 = false;
      window.__origFetch = window.fetch;
      window.fetch = (url, opts) => {
        if (String(url).indexOf('chat/completions') < 0) return window.__origFetch(url, opts);
        if (window.__mock402) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'quota' } }),
          { status: 402, headers: { 'Content-Type': 'application/json' } }));
        const prompt = JSON.parse(opts.body).messages.map(m => m.content).join('\\n');
        const payload = prompt.indexOf('分幕大纲') >= 0 ? OUTLINE
          : (prompt.indexOf('请修复') >= 0 ? { scenes: SCENES } : { scenes: SCENES });
        const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\\n\\ndata: [DONE]\\n\\n';
        return Promise.resolve(new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
      };
    })()`);
    /* 打开 AI 生成模态，填表，生成 */
    if (!(await visible('#title-screen'))) { await click('#mb-title'); await waitFor(() => visible('#title-screen'), 5000, '回标题'); }
    await click('#btn-ai-gen');
    await waitFor(() => visible('#an-form'), 5000, 'AI 生成表单');
    await ev(`document.getElementById('an-theme').value = 'mock茶棚夜雨'`);
    await ev(`(() => {
      const names = document.querySelectorAll('.an-char-name'), descs = document.querySelectorAll('.an-char-desc');
      names[0].value = '阿茶'; descs[0].value = '温柔茶娘';
      names[1].value = '行客'; descs[1].value = '沉默旅人';
    })()`);
    await ev(`document.getElementById('an-scenes').value = '3'`);
    await ev(`document.getElementById('an-key').value = 'mock-key'`);
    await click('#an-generate');
    await waitFor(() => visible('#an-done'), 60000, '生成完成面板');
    const doneText = await ev(`document.getElementById('an-done-log').textContent`);
    if (!/生成完成/.test(doneText)) throw new Error('结果面板异常: ' + doneText.slice(0, 80));
    /* 开玩：新剧本载入，可推进 */
    await click('#an-play');
    await sleep(500);
    if (await visible('#name-input-overlay')) {
      await ev(`document.getElementById('name-input-field').value = 'mock玩家'`);
      await click('#name-input-confirm');
    }
    await waitFor(async () => (await ev(`document.getElementById('dlgtext').textContent.length`)) > 0, 8000, '新剧本首条对话');
    const title = await ev(`document.getElementById('game-title').textContent`);
    const sprite = await ev(`(() => { const i = document.querySelector('.slot img'); return i && i.src ? i.src : null; })()`);
    if (sprite && !/chars\/(su|shen|tang|mo|wan)_/.test(sprite)) throw new Error('立绘未映射到现有素材库: ' + sprite);
    let steps = 0, ended = false;
    for (let i = 0; i < 30 && steps < 4; i++) {
      const t = await step();
      if (t === 'dlg') steps++;
      if (t === 'end') { ended = true; break; }
      await sleep(80);
    }
    if (steps < 3) throw new Error('新剧本只推进了 ' + steps + ' 条');
    return '标题=' + title + '，推进 ' + steps + ' 条' + (ended ? '，已到结局' : '') + '，立绘映射=' + (sprite ? sprite.split('/').pop() : '剪影兜底');
  });

  /* ---------- 用例 12：AI 生成 402 额度不足友好提示 ---------- */
  await runCase('12. AI生成 402 → 显示额度不足提示', async () => {
    await ev(`document.getElementById('mb-title') && document.getElementById('mb-title').click()`).catch(() => {});
    await sleep(300);
    if (!(await visible('#title-screen'))) await ev(`backToTitle()`);
    await waitFor(() => visible('#title-screen'), 5000, '回标题');
    await ev(`window.__mock402 = true`);
    await click('#btn-ai-gen');
    await waitFor(() => visible('#an-form'), 5000, 'AI 生成表单');
    await ev(`document.getElementById('an-theme').value = 'mock额度测试'`);
    await ev(`document.getElementById('an-key').value = 'mock-key'`);
    await click('#an-generate');
    await waitFor(async () => {
      const t = await ev(`document.getElementById('an-log').textContent`);
      return /额度不足|生成失败/.test(t) ? t : null;
    }, 30000, '402 错误提示出现');
    const logText = await ev(`document.getElementById('an-log').textContent`);
    if (!/额度不足/.test(logText)) throw new Error('缺少「额度不足」提示: ' + logText.slice(-120));
    await ev(`window.__mock402 = false; window.fetch = window.__origFetch;`);
    await ev(`document.getElementById('an-cancel').click()`).catch(() => {});
    await sleep(200);
    await ev(`window.AutoNovel.close && window.AutoNovel.close()`).catch(() => {});
    return '日志含「额度不足」中文提示';
  });

  /* ================= 汇总 ================= */
  console.log('\n================ E2E 结果 ================');
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
