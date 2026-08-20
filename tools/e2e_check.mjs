#!/usr/bin/env node
/* ============================================================================
 * e2e_check.mjs —— 判定指令 check + 属性归属 owner 专项验证
 *
 * 复用 e2e_test.mjs 基建（python http.server + headless Edge + 原生 CDP），
 * 端口 8134/9234 防冲突。伺服现有 dist/（需先 python tools/build.py）。
 *
 * 用例：
 *   a. judge 模式成功路径：属性达标 → overlay 显示「判定成功」→ 走 success.goto
 *   b. judge 失败路径：属性不达标 → 「判定失败」→ 走 fail.goto
 *   c. roll 模式：Math.random 打桩固定骰值 → 成功/失败两分支各走对
 *   d. 判定 overlay 自动消失并推进（无跳转时顺序继续）
 *   e. 编辑器插入判定指令（指令盘→🎲）→ 可视化改属性/数值/模式/成功跳转 → JSON 正确
 *   f. 属性面板分组：主控（玩家名）/ ❤角色 / 好感排前
 *
 * 用法：node tools/e2e_check.mjs
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8134);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9234);
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

let failed = 0;
function ok(cond, name, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '　' + detail : ''));
  if (!cond) failed++;
}

/* 判定测试迷你剧本：s0 里一条 check，按结果跳 s_a / s_b */
function miniScript(checkCmd, attrInit) {
  return {
    meta: { title: 'check测试', author: 'e2e', version: '1.0',
            defaults: { text_speed: 0, bgm_volume: 0, auto_delay: 100 } },
    attrs: { charm: { name: '魅力', init: attrInit, min: 0, max: 100, owner: 'player' } },
    characters: { a: { name: '甲', color: '#fff', sprites: {} } },
    assets_dir: 'assets/',
    scenes: [
      { id: 's0', chars: [], script: [checkCmd] },
      { id: 's_a', script: [{ type: 'narrate', text: '成功线' }, { type: 'end', label: 'A' }] },
      { id: 's_b', script: [{ type: 'narrate', text: '失败线' }, { type: 'end', label: 'B' }] },
    ],
  };
}

/* 载入迷你剧本并开局（处理起名框），等待 check overlay 出现 */
async function startMini(checkCmd, attrInit) {
  await ev(`loadScript(${jsonLiteral(miniScript(checkCmd, attrInit))})`);
  await ev(`void startNewGame()`);   /* async：内部等起名框，不能让 CDP 等 promise */
  await sleep(300);
  if (await ev(`!document.getElementById('name-input-overlay').classList.contains('hidden')`)) {
    await ev(`document.getElementById('name-input-field').value = '判定员'`);
    await click('#name-input-confirm');
  }
  await waitFor(() => ev(`waiting === 'check'`), 8000, '进入 check 等待态');
}
function jsonLiteral(obj) { return JSON.stringify(obj); }

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/index.html 不存在，先跑 python tools/build.py');
  const distHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  if (!distHtml.includes('check-layer')) throw new Error('dist 不是新版本（缺 check-layer），先跑 build.py');

  const server = spawn('python', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIST, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(BASE + '/index.html')).ok, 10000, 'http.server 就绪');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wenyou-check-'));
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
  ok(await ev(`typeof loadScript === 'function' && typeof startNewGame === 'function'`),
    '0. 页面加载，引擎全局函数可用');

  /* ---------- a. judge 成功路径 ---------- */
  const judgeCmd = { type: 'check', attr: 'charm', op: '>=', value: 15, mode: 'judge',
                     text: '魅力判定', success: { goto: 's_a' }, fail: { goto: 's_b' } };
  await startMini(judgeCmd, 20);
  await waitFor(() => ev(`document.getElementById('check-result').textContent`), 5000, 'judge 结果亮出');
  const aRes = await ev(`document.getElementById('check-result').textContent`);
  ok(aRes === '判定成功', 'a1. judge 达标 → 显示「判定成功」', aRes);
  await click('#check-layer');   /* 点击继续 → success.goto */
  await waitFor(() => ev(`script.scenes[sceneIdx].id`), 5000, '场景落定');
  ok(await ev(`script.scenes[sceneIdx].id`) === 's_a', 'a2. 成功走到 success.goto 场景 s_a');

  /* ---------- b. judge 失败路径 ---------- */
  await startMini(judgeCmd, 5);
  await waitFor(() => ev(`document.getElementById('check-result').textContent`), 5000, 'judge 结果亮出');
  const bRes = await ev(`document.getElementById('check-result').textContent`);
  ok(bRes === '判定失败', 'b1. judge 不达标 → 显示「判定失败」', bRes);
  await click('#check-layer');
  await waitFor(() => ev(`script.scenes[sceneIdx].id === 's_b'`), 5000, '进入 s_b');
  ok(true, 'b2. 失败走到 fail.goto 场景 s_b');

  /* ---------- c. roll 模式：Math.random 打桩 ---------- */
  const rollCmd = { type: 'check', attr: 'charm', mode: 'roll', value: 15,
                    text: '掷骰判定', success: { goto: 's_a' }, fail: { goto: 's_b' } };
  /* c1: 固定骰 20（charm=0 → 20+0 >= 15 成功） */
  await ev(`Math.random = () => 0.99`);
  await startMini(rollCmd, 0);
  await waitFor(() => ev(`document.getElementById('check-result').textContent`), 5000, 'roll 定格亮结果');
  const cDice = await ev(`document.getElementById('check-dice').textContent`);
  const cRes = await ev(`document.getElementById('check-result').textContent`);
  ok(cRes === '判定成功' && /🎲 20 \+ 0 = 20/.test(cDice),
    'c1. roll 骰20 → 成功', cDice + ' / ' + cRes);
  await click('#check-layer');
  await waitFor(() => ev(`script.scenes[sceneIdx].id === 's_a'`), 5000, 'roll 成功进 s_a');
  ok(true, 'c2. roll 成功分支走对');
  /* c2: 固定骰 1（1+0 < 15 失败） */
  await ev(`Math.random = () => 0`);
  await startMini(rollCmd, 0);
  await waitFor(() => ev(`document.getElementById('check-result').textContent`), 5000, 'roll 定格亮结果');
  const c2Dice = await ev(`document.getElementById('check-dice').textContent`);
  const c2Res = await ev(`document.getElementById('check-result').textContent`);
  ok(c2Res === '判定失败' && /🎲 1 \+ 0 = 1/.test(c2Dice),
    'c3. roll 骰1 → 失败', c2Dice + ' / ' + c2Res);
  await click('#check-layer');
  await waitFor(() => ev(`script.scenes[sceneIdx].id === 's_b'`), 5000, 'roll 失败进 s_b');
  ok(true, 'c4. roll 失败分支走对');

  /* ---------- d. overlay 自动消失并顺序推进（无 goto） ---------- */
  await ev(`delete Math.random`);   /* 恢复真随机（打桩是直接赋值，delete 即可还原） */
  await startMini({ type: 'check', attr: 'charm', op: '>=', value: 10, mode: 'judge' }, 20);
  await waitFor(() => ev(`!document.getElementById('check-layer').classList.contains('hidden')`),
    5000, 'overlay 出现');
  ok(true, 'd1. 判定 overlay 出现');
  /* 不点击：1.6s 自动继续，s0 无更多指令 → 顺序流向下一场景？s0 只有 check，
     引擎顺序执行到场景末尾即停；断言 overlay 消失且 waiting 清空 */
  await waitFor(() => ev(`document.getElementById('check-layer').classList.contains('hidden') && waiting !== 'check'`),
    6000, 'overlay 自动消失');
  ok(true, 'd2. 1.6s 自动继续，overlay 消失且推进');

  /* ---------- e. 编辑器：指令盘插入 🎲判定 → 可视化编辑 → JSON ---------- */
  await ev(`backToTitle()`);
  await click('#btn-editor');
  await waitFor(() => ev(`!document.getElementById('scene-editor').classList.contains('hidden')`), 5000, '编辑器打开');
  await sleep(600);
  /* 当前是迷你剧本 s0（仅 1 条 check）。先在末尾空隙插入一条新判定 */
  const gapN = await ev(`script.scenes[0].script.length`);
  await click(`.tl-gap[data-gap="${gapN}"]`);
  await waitFor(() => ev(`!!document.querySelector('.se-grid-pop')`), 5000, '指令选择盘弹出');
  await click('.se-grid-pop .se-grid-cell[data-value="check"]');
  await waitFor(() => ev(`(() => {
    const c = script.scenes[0].script[${gapN}];
    return c && c.type === 'check' && !!document.querySelector('#se-pv-text .ck-attr');
  })()`), 5000, '判定插入且画布可视化表单渲染');
  ok(true, 'e1. 指令盘 🎲判定 插入成功，画布出现判定编辑表单');
  /* 可视化改：数值难度 + 模式 + 成功跳转 chip */
  await ev(`(() => {
    const v = document.querySelector('#se-pv-text .ck-val');
    v.value = '25'; v.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(150);
  ok(await ev(`script.scenes[0].script[${gapN}].value`) === 25, 'e2. 可视化改数值 → value=25');
  await ev(`(() => {
    const m = document.querySelector('#se-pv-text .ck-mode');
    m.value = 'roll'; m.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(150);
  ok(await ev(`script.scenes[0].script[${gapN}].mode`) === 'roll', 'e3. 可视化改模式 → mode=roll');
  /* 成功 chip → 场景网格选 s_a */
  await click('#se-pv-text .ck-success');
  await waitFor(() => ev(`!!document.querySelector('.se-grid-pop')`), 5000, '成功分支场景网格弹出');
  await click('.se-grid-pop .se-grid-cell[data-value="s_a"]');
  await sleep(150);
  ok(await ev(`(script.scenes[0].script[${gapN}].success||{}).goto`) === 's_a',
    'e4. 成功 chip 点选场景 → success.goto=s_a');
  /* chip 可清空 */
  await click('#se-pv-text .ck-success');
  await waitFor(() => ev(`!!document.querySelector('.se-grid-pop')`), 5000, '场景网格再弹出');
  await click('.se-grid-pop .se-grid-cell[data-value=""]');
  await sleep(150);
  ok(await ev(`!((script.scenes[0].script[${gapN}].success||{}).goto)`), 'e5. 成功 chip 可清空');
  /* 时间轴逻辑轨出现 🎲 色块 */
  ok(await ev(`!!document.querySelector('#tl-other .tl-block.check')`), 'e6. 时间轴逻辑轨有 🎲 色块');

  /* ---------- f. 属性面板分组（主剧本：favor_* 归属角色、charm 归属主控） ---------- */
  await ev(`location.reload()`);
  await waitFor(() => ev(`document.readyState === 'complete'`), 20000, '重载完成');
  await sleep(1200);
  await click('#btn-start');
  await waitFor(() => ev(`!document.getElementById('name-input-overlay').classList.contains('hidden')`), 5000, '起名框');
  await ev(`document.getElementById('name-input-field').value = '分组测试员'`);
  await click('#name-input-confirm');
  await sleep(800);
  await ev(`renderAttrPanel(); document.getElementById('attr-panel').classList.remove('hidden')`);
  const groups = await ev(`[...document.querySelectorAll('#attr-list .attr-group-head')].map(h => h.dataset.group)`);
  ok(groups[0] === 'player', 'f1. 第一组是主控', JSON.stringify(groups));
  ok(groups.includes('su') && groups.includes('shen') && groups.includes('tang'),
    'f2. 三个归属角色各一组', groups.join(','));
  const playerHead = await ev(`document.querySelector('#attr-list .attr-group-head[data-group="player"]').textContent`);
  ok(playerHead.includes('分组测试员'), 'f3. 主控组头显示玩家输入的名字', playerHead);
  const suHead = await ev(`document.querySelector('#attr-list .attr-group-head[data-group="su"]').textContent`);
  ok(/❤/.test(suHead) && suHead.includes('苏璃'), 'f4. 角色组头含 ❤ + 角色名', suHead);

  console.log('------------------------------------------');
  console.log(failed ? failed + ' 项失败' : '全部通过');
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('运行失败:', e.message); cleanup(); process.exit(2); });
