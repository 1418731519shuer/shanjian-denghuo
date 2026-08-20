#!/usr/bin/env node
/* ============================================================================
 * e2e_editor.mjs —— 剪辑式场景编辑器 + 素材上传 端到端测试
 * （真实 Edge headless + CDP，零依赖；基建复用自 e2e_test.mjs）
 *
 * 用例：
 *   a. 时间轴「剪辑」行点 + → 指令选择盘选旁白 → 画布预览直接打字
 *      → 导出 JSON 含该指令（全程不碰表单/JSON）
 *   b. choice 选项卡的「→目标场景」chip → 场景缩略图网格改目标 → JSON goto 变化
 *   c. 上传一张生成的 PNG 为「背景」→ slug 规范化命名 → 画布/场景背景立即显示
 *      → 导出素材包包含它 → 刷新页面 localStorage 恢复仍显示
 *   d. 条件构造器给选项加 [favor_su>=5] → JSON if 正确
 *
 * 用法：node tools/e2e_editor.mjs   （前置：python tools/build.py）
 * 环境变量：E2E_EDGE / E2E_HTTP_PORT（默认 8129）/ E2E_CDP_PORT（默认 9229）/ E2E_KEEP=1
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8129);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9229);
const EDGE = process.env.E2E_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const KEEP = !!process.env.E2E_KEEP;

/* 32x32 红块 PNG（上传用例的喂入文件） */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAK0lEQVR4nO3NQREAAAQAQeTSf8RSgt9egNuc7visXu8AAAAAAAAAAADgsAW3HAGAoQdf+gAAAABJRU5ErkJggg==';

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

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-e2eed-'));
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
  await cdp.send('DOM.enable');
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
  const enterEditor = async () => {
    await click('#btn-editor');
    await waitFor(() => ev(`!document.getElementById('scene-editor').classList.contains('hidden')`), 5000, '编辑器打开');
    await sleep(600);
  };

  await gotoReady(BASE + '/');

  /* ---------- 用例 a：剪辑行 + 插入旁白 → 画布打字 → 导出 JSON ---------- */
  await runCase('a. 剪辑行+插入旁白 → 画布编辑 → 导出 JSON 含该指令', async () => {
    await enterEditor();
    /* 点第 1 条后的空隙（gap=1 即插到索引 1） */
    await click('.tl-gap[data-gap="1"]');
    await waitFor(() => ev(`!!document.querySelector('.se-grid-pop')`), 5000, '指令选择盘弹出');
    await click('.se-grid-pop .se-grid-cell[data-value="narrate"]');
    await waitFor(() => ev(`(() => {
      const sc = script.scenes[0];
      return sc.script[1] && sc.script[1].type === 'narrate' &&
        document.getElementById('se-preview-overlay').classList.contains('show');
    })()`), 5000, '旁白已插入且画布进入编辑态');
    /* 全程不碰表单：直接在画布预览文本里打字（派生 input 事件） */
    await ev(`(() => {
      const t = document.getElementById('se-pv-text');
      t.textContent = '剪辑插入的旁白测试句';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(150);
    const inMem = await ev(`script.scenes[0].script[1].text`);
    if (inMem !== '剪辑插入的旁白测试句') throw new Error('画布打字未写回指令: ' + inMem);
    /* 走真实导出路径，截获 Blob 验证内容 */
    const exported = await ev(`(async () => {
      const orig = URL.createObjectURL.bind(URL);
      let blob = null;
      URL.createObjectURL = b => { blob = b; return orig(b); };
      exportEditorJSON();
      URL.createObjectURL = orig;
      return blob ? await blob.text() : null;
    })()`);
    if (!exported) throw new Error('exportEditorJSON 未产生 Blob');
    const j = JSON.parse(exported);
    if (!(j.scenes[0].script[1] && j.scenes[0].script[1].text === '剪辑插入的旁白测试句'))
      throw new Error('导出 JSON 不含新旁白');
    return 'script[1]=narrate「剪辑插入的旁白测试句」，导出 JSON 一致';
  });

  /* ---------- 用例 b：选项卡「→目标场景」chip 改跳转 ---------- */
  await runCase('b. choice 选项 goto chip → 场景网格改目标 → JSON 变化', async () => {
    /* 找到 choice 指令（用例 a 插入后索引已移动，动态定位） */
    const ci = await ev(`script.scenes[0].script.findIndex(c => c.type === 'choice')`);
    if (ci < 0) throw new Error('场景0没有 choice 指令');
    await click(`#tl-dialog .tl-block.choice[data-idx="${ci}"]`);
    await waitFor(() => ev(`!!document.querySelector('#se-pv-text .opt-card')`), 5000, '选项卡片渲染');
    const before = await ev(`script.scenes[0].script[${ci}].options[0].goto || ''`);
    await click('#se-pv-text .opt-card .opt-chip.goto');
    await waitFor(() => ev(`!!document.querySelector('.se-grid-pop')`), 5000, '场景网格弹出');
    const picked = await ev(`(() => {
      const cells = [...document.querySelectorAll('.se-grid-pop .se-grid-cell')];
      const c = cells.find(x => x.dataset.value && x.dataset.value !== ${JSON.stringify('')} && x.dataset.value !== (script.scenes[0].script[${ci}].options[0].goto || ''));
      if (!c) return null;
      c.click();
      return c.dataset.value;
    })()`);
    if (!picked) throw new Error('场景网格里没有可换的目标');
    await sleep(200);
    const after = await ev(`script.scenes[0].script[${ci}].options[0].goto || ''`);
    if (after !== picked || after === before) throw new Error(`goto 未变化：${before} → ${after}（点选 ${picked}）`);
    const chipText = await ev(`document.querySelector('#se-pv-text .opt-card .opt-chip.goto').textContent`);
    return `goto ${before || '(无)'} → ${after}，chip 显示「${chipText}」`;
  });

  /* ---------- 用例 c：上传 PNG 为背景 → slug 命名 → 立即显示 → 素材包 → 刷新恢复 ---------- */
  await runCase('c. 上传背景 → 规范化命名 → 立即显示 → 素材包 → 刷新恢复', async () => {
    const pngPath = path.join(os.tmpdir(), 'My BG!!.png');
    fs.writeFileSync(pngPath, Buffer.from(PNG_B64, 'base64'));
    const doc = await cdp.send('DOM.getDocument', { depth: 1 });
    const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#asset-file-input' });
    await cdp.send('DOM.setFileInputFiles', { files: [pngPath], nodeId: q.nodeId });
    await waitFor(() => ev(`!!document.getElementById('upload-panel')`), 5000, '上传面板弹出');
    /* 类型默认=背景；命名故意写成带非法字符，验证 slug 规范化提示 */
    await ev(`(() => {
      const s = document.getElementById('up-slug');
      s.value = 'E2E Bg!!';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const hint = await ev(`document.getElementById('up-slug-hint').textContent`);
    if (!/e2e_bg/.test(hint)) throw new Error('slug 规范化提示异常: ' + hint);
    await click('#up-confirm');
    await waitFor(() => ev(`!!customAssets['bg/e2e_bg.webp']`), 8000, '素材注册进内存表');
    const bgPath = await ev(`script.scenes[0].background`);
    if (bgPath !== 'bg/e2e_bg.webp') throw new Error('场景背景未自动设为上传素材: ' + bgPath);
    /* 画布背景立即可见（dataURL 解码出真实像素） */
    const shown = await ev(`(async () => {
      const bg = document.getElementById('se-canvas-bg');
      const m = (bg.style.backgroundImage || '').match(/url\\("?(.*?)"?\\)/);
      if (!m) return { ok: false, why: '画布无背景图' };
      return await new Promise(res => { const i = new Image(); i.onload = () => res({ ok: i.naturalWidth > 0, w: i.naturalWidth }); i.onerror = () => res({ ok: false, why: '解码失败' }); i.src = m[1]; });
    })()`);
    if (!shown.ok) throw new Error('画布背景未显示上传图: ' + (shown.why || ''));
    /* 缩略图按钮也换成上传图 */
    const btnOk = await ev(`(() => { const i = document.querySelector('#se-bg-select img'); return !!(i && i.src.startsWith('data:image/webp')); })()`);
    /* 导出素材包包含它 */
    const pack = await ev(`(async () => {
      const orig = URL.createObjectURL.bind(URL);
      let blob = null;
      URL.createObjectURL = b => { blob = b; return orig(b); };
      exportAssetsPack();
      URL.createObjectURL = orig;
      return blob ? await blob.text() : null;
    })()`);
    if (!pack || !pack.includes('bg/e2e_bg.webp')) throw new Error('素材包不含上传素材');
    /* 刷新页面 → localStorage 恢复 → 仍显示 */
    await gotoReady(BASE + '/');
    const restored = await ev(`(() => {
      const ls = localStorage.getItem('wenyou_custom_assets') || '';
      return { ls: ls.includes('bg/e2e_bg.webp'), mem: !!customAssets['bg/e2e_bg.webp'] };
    })()`);
    if (!restored.ls || !restored.mem) throw new Error('刷新后素材未恢复: ' + JSON.stringify(restored));
    await enterEditor();
    await click('#se-bg-select');
    await waitFor(() => ev(`!!document.querySelector('.se-grid-pop')`), 5000, '背景网格弹出');
    const cellOk = await ev(`(async () => {
      const cell = [...document.querySelectorAll('.se-grid-pop .se-grid-cell')].find(c => c.dataset.value === 'bg/e2e_bg.webp');
      if (!cell) return { ok: false, why: '网格缺上传背景格' };
      const img = cell.querySelector('img');
      if (!img) return { ok: false, why: '格内无图' };
      if (img.complete && img.naturalWidth > 0) return { ok: true };
      return await new Promise(res => { img.onload = () => res({ ok: img.naturalWidth > 0 }); img.onerror = () => res({ ok: false, why: '恢复后解码失败' }); });
    })()`);
    if (!cellOk.ok) throw new Error('刷新后背景网格: ' + (cellOk.why || '图未显示'));
    return `slug「E2E Bg!!」→bg/e2e_bg.webp，画布 ${shown.w}px，缩略图按钮=${btnOk}，素材包含它，刷新后恢复仍显示`;
  });

  /* ---------- 用例 d：条件构造器给选项加 [favor_su>=5] ---------- */
  await runCase('d. 条件构造器 → 选项 if=[favor_su>=5] → JSON 正确', async () => {
    const ci = await ev(`script.scenes[0].script.findIndex(c => c.type === 'choice')`);
    await click(`#tl-dialog .tl-block.choice[data-idx="${ci}"]`);
    await waitFor(() => ev(`!!document.querySelector('#se-pv-text .opt-card')`), 5000, '选项卡片渲染');
    await click('#se-pv-text .opt-card .opt-chip.cond');
    await waitFor(() => ev(`!!document.getElementById('cb-attr')`), 5000, '条件构造器弹出');
    await ev(`(() => {
      const a = document.getElementById('cb-attr');
      a.value = 'favor_su'; a.dispatchEvent(new Event('change', { bubbles: true }));
      const o = document.getElementById('cb-op');
      o.value = '>='; o.dispatchEvent(new Event('change', { bubbles: true }));
      const v = document.getElementById('cb-val');
      v.value = '5'; v.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await click('#cb-save');
    await sleep(200);
    const ifExpr = await ev(`script.scenes[0].script[${ci}].options[0].if || ''`);
    if (ifExpr !== 'favor_su>=5') throw new Error('条件写回错误: ' + ifExpr);
    const chip = await ev(`document.querySelector('#se-pv-text .opt-card .opt-chip.cond').textContent`);
    if (!chip.includes('favor_su>=5')) throw new Error('条件 chip 未回显: ' + chip);
    return `if=${ifExpr}，chip 回显「${chip}」`;
  });

  /* ---------- 用例 e：撤销/重做（按钮 + Ctrl+Z/Y） ---------- */
  await runCase('e. 撤销/重做：插入指令可撤销再重做', async () => {
    await enterEditor();
    const before = await ev(`script.scenes[0].script.length`);
    /* 插入一条旁白 */
    await click('.tl-gap[data-gap="1"]');
    await waitFor(() => ev(`!!document.querySelector('.se-grid-pop')`), 5000, '指令选择盘');
    await click('.se-grid-pop .se-grid-cell[data-value="narrate"]');
    await waitFor(async () => (await ev(`script.scenes[0].script.length`)) === before + 1, 5000, '插入生效');
    /* 按钮应可用 → Ctrl+Z 撤销 */
    if (await ev(`document.getElementById('se-undo').disabled`)) throw new Error('撤销按钮未激活');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
    await sleep(400);
    const afterUndo = await ev(`script.scenes[0].script.length`);
    if (afterUndo !== before) throw new Error(`Ctrl+Z 后指令数 ${afterUndo} ≠ ${before}`);
    if (await ev(`document.getElementById('se-redo').disabled`)) throw new Error('重做按钮未激活');
    /* Ctrl+Y 重做 */
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))`);
    await sleep(400);
    const afterRedo = await ev(`script.scenes[0].script.length`);
    if (afterRedo !== before + 1) throw new Error(`Ctrl+Y 后指令数 ${afterRedo} ≠ ${before + 1}`);
    /* 再撤销掉，保持剧本原样 */
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
    await sleep(400);
    if ((await ev(`script.scenes[0].script.length`)) !== before) throw new Error('二次撤销未复原');
    return `插入→撤销(${before})→重做(${before + 1})→再撤销(${before}) 全链路正确`;
  });

  /* ---------- 用例 f：场景卡片双击改名同步更新引用 ---------- */
  await runCase('f. 场景卡片双击改名 → 全剧本引用同步', async () => {
    await enterEditor();
    /* 找一个被 goto 引用的场景作为改名对象 */
    const target = await ev(`(() => {
      const refd = new Set();
      script.scenes.forEach(s => (s.script || []).forEach(c => {
        if (c.type === 'goto' && c.target) refd.add(c.target);
        if (c.type === 'choice') (c.options || []).forEach(o => o.goto && refd.add(o.goto));
      }));
      const idx = script.scenes.findIndex(s => refd.has(s.id));
      return { idx, id: idx >= 0 ? script.scenes[idx].id : null };
    })()`);
    if (!target.id) return '剧本无 goto 引用场景，跳过（不影响功能）';
    await ev(`window.prompt = () => 'renamed_e2e'`);
    await ev(`document.querySelectorAll('.se-scene-card')[${target.idx}].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await sleep(400);
    const after = await ev(`(() => {
      const renamed = script.scenes[${target.idx}].id === 'renamed_e2e';
      let dangling = 0;
      const ids = new Set(script.scenes.map(s => s.id));
      script.scenes.forEach(s => (s.script || []).forEach(c => {
        if (c.type === 'goto' && c.target && !ids.has(c.target)) dangling++;
        if (c.type === 'choice') (c.options || []).forEach(o => { if (o.goto && !ids.has(o.goto)) dangling++; });
      }));
      return { renamed, dangling };
    })()`);
    if (!after.renamed) throw new Error('场景未改名');
    if (after.dangling) throw new Error('改名后存在悬空引用×' + after.dangling);
    /* 撤销改名复原（引用一并回滚），保持剧本原样 */
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
    await sleep(400);
    const restored = await ev(`script.scenes[${target.idx}].id`);
    if (restored !== target.id) throw new Error('撤销后未复原: ' + restored);
    return `${target.id} → renamed_e2e → 引用同步、撤销复原`;
  });

  /* ================= 汇总 ================= */
  console.log('\n================ E2E（编辑器）结果 ================');
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
