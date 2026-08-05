/* ============================================================================
 * ai_gen.js —— 网页端 AI 自动写剧本（工作流C2）
 *
 * 复刻 script_gen.py 的三步管线到浏览器端：
 *   ① chat 生成分幕大纲 → ② 逐幕生成 scene JSON → ③ 前端校验 + LLM 修复（至多2轮）
 * 生成成功后自动做资源映射（背景/立绘 → 现有素材库），调引擎全局 loadScript() 载入开玩。
 *
 * 【集成方式】（由主线负责，本文件不修改 index.html）：
 *   1. 在 demo_gl/index.html 的 </body> 前加：
 *        <script src="ai_gen.js"></script>
 *   2. 需要入口时在标题页加按钮，onclick 调 window.AutoNovel.open()
 *   3. 部署注意：tools/build.py 已会把本文件拷入 dist/（图片扩展名 .png/.jpg ↔ .webp
 *      的差异由本文件运行时自动探测，无需构建期改写）
 *
 * 依赖：无（原生 JS）。引擎侧只读全局函数 loadScript / startNewGame（index.html 定义）。
 * ========================================================================== */
(function () {
  'use strict';

  /* ================= 常量（译自 script_gen.py） ================= */
  const API_URL = 'https://api.stepfun.com/v1/chat/completions';
  const MODEL = 'step-3.7-flash';
  const MAX_PARSE_RETRY = 3;   // JSON 抽取失败重试次数
  const MAX_FIX_ROUND = 2;     // 校验失败让 LLM 修复的轮数上限
  const MAX_TOKENS = 8192;     // 一幕可能含多个 scene，太小会截断坏 JSON
  const LS_KEY = 'autonovel_step_key'; // API key 的 localStorage 键

  const SCENE_FIELDS = ['id', 'background', 'bgm', 'sfx', 'checkpoint', 'chars', 'script'];
  const CMD_TYPES = ['narrate', 'say', 'choice', 'set', 'goto', 'inspect', 'show', 'end'];
  const CMD_FIELDS = {
    narrate: ['type', 'text', 'if'],
    say: ['type', 'who', 'text', 'if'],
    choice: ['type', 'options', 'if'],
    set: ['type', 'vars', 'if'],
    goto: ['type', 'target', 'if'],
    inspect: ['type', 'x', 'y', 'w', 'h', 'show', 'if'],
    show: ['type', 'image', 'if'],
    end: ['type', 'label', 'if'],
  };
  const OPTION_FIELDS = ['text', 'goto', 'set', 'if'];
  const POS_VALUES = ['left', 'center', 'right'];
  const EFFECT_VALUES = ['fade', 'slide', 'none'];
  const COND_ALIASES = ['condition', 'cond', 'when'];
  const DEFAULT_EMOTIONS = ['normal', 'smile', 'angry', 'sad', 'surprise'];

  // 系统提示词：与 script_gen.py 的 SYSTEM_JSON 保持一致
  const SYSTEM_JSON =
    '你是文游剧本生成器。只输出 JSON，不要 markdown 代码块，不要任何解释文字。\n' +
    '剧本 Schema 摘要：顶层 {meta, characters, assets_dir, scenes[]}；\n' +
    'scene 字段仅允许 id/background/bgm/sfx/checkpoint/chars/script；\n' +
    'chars[] 元素 {id, pos(left|center|right), sprite, effect(fade|slide|none)}；\n' +
    'script[] 指令仅允许 8 种：\n' +
    '  {"type":"narrate","text":...}；\n' +
    '  {"type":"say","who":角色id,"text":...}（支持 {变量} 插值）；\n' +
    '  {"type":"choice","options":[{"text":...,"set":{变量:值},"goto":scene_id,"if":条件}]}；\n' +
    '  {"type":"set","vars":{"flag_x":1,"favor":"favor+1"}}；\n' +
    '  {"type":"goto","target":scene_id}；\n' +
    '  {"type":"inspect","x":0~1,"y":0~1,"w":0~1,"h":0~1,"show":{"image":可选,"text":必填}}；\n' +
    '  {"type":"show","image":"cg/xxx.png"}；\n' +
    '  {"type":"end","label":"结局·xxx"}。\n' +
    '条件字段统一叫 if，表达式支持 == != > < >= <= && || ! 和括号，未定义变量按 0。\n' +
    '变量命名规范：^[a-z][a-z0-9_]{0,31}$，前缀约定 flag_ / favor / item_。\n' +
    '素材路径只用英文小写+数字+下划线，相对 assets_dir：bg/ 背景、chars/ 立绘、cg/ CG、bgm/ 音频。';

  /* ================= 素材库硬编码匹配表（对应 demo_gl/assets） ================= */
  // 背景：关键词 → assets/bg 下的现有文件（命中多的胜出）
  const BG_TABLE = [
    { file: 'bg/ferry_night.jpg',       kw: ['ferry', 'boat', 'river', 'dock', 'ship', '渡', '船', '河', '码头'] },
    { file: 'bg/street_night.jpg',      kw: ['street', 'alley', 'road', 'lane', '街', '巷'] },
    { file: 'bg/city_lights.jpg',       kw: ['city', 'urban', 'neon', 'downtown', '城', '都市', '霓虹'] },
    { file: 'bg/cafe_rainy.jpg',        kw: ['rain', 'rainy', 'storm', '雨'] },
    { file: 'bg/cafe_afternoon.jpg',    kw: ['cafe', 'coffee', 'afternoon', '咖啡'] },
    { file: 'bg/lantern_shop.jpg',      kw: ['lantern', 'lamp', 'shop', '灯', '铺'] },
    { file: 'bg/festival_night.jpg',    kw: ['festival', 'fair', 'celebration', 'temple', '灯会', '庆典', '庙会', '节'] },
    { file: 'bg/teashelter.jpg',        kw: ['tea', 'teahouse', 'shelter', '茶'] },
    { file: 'bg/bamboo.jpg',            kw: ['bamboo', 'forest', 'woods', 'grove', '竹', '林'] },
    { file: 'bg/bridge_sunset.jpg',     kw: ['bridge', 'sunset', '桥', '夕阳'] },
    { file: 'bg/law_firm_office.jpg',   kw: ['office', 'law', 'firm', 'company', '事务', '办公', '律所', '公司'] },
    { file: 'bg/restaurant_evening.jpg',kw: ['restaurant', 'dinner', 'food', 'tavern', 'inn', '餐', '饭', '酒楼', '客栈'] },
    { file: 'bg/taxi_night.jpg',        kw: ['taxi', 'car', 'drive', '车'] },
    { file: 'bg/town_day.jpg',          kw: ['town', 'village', 'day', 'morning', 'home', '镇', '村', '家'] },
  ];
  // 夜版/黄昏版：名称含 night/夜 时优先
  const BG_NIGHT_TABLE = [
    { file: 'bg/bamboo_night.jpg',      kw: ['bamboo', 'forest', 'woods', 'grove', '竹', '林'] },
    { file: 'bg/teashelter_night.jpg',  kw: ['tea', 'teahouse', 'shelter', '茶'] },
    { file: 'bg/law_firm_dusk.jpg',     kw: ['office', 'law', 'firm', 'dusk', '事务', '办公', '律所'] },
  ];
  const BG_FALLBACK_DAY = 'bg/town_day.jpg';
  const BG_FALLBACK_NIGHT = 'bg/street_night.jpg';

  // 立绘套装：生成角色按顺序映射到这 5 套（c1→su, c2→shen, ...）
  const SPRITE_SETS = ['su', 'shen', 'tang', 'mo', 'wan'];
  // 角色名字框默认配色（与现有角色色系一致）
  const CHAR_COLORS = ['#FFB6C1', '#87CEEB', '#E8C47E', '#C8A2E8'];

  // CG：show/inspect 引用的图片 → 现有 cg 文件
  const CG_TABLE = [
    { file: 'cg/sword_light.jpg', kw: ['sword', 'blade', 'fight', 'battle', '剑', '刀', '战'] },
    { file: 'cg/teacup.png',      kw: ['tea', 'cup', 'teacup', '茶', '盏', '杯'] },
  ];

  /* ================= 工具函数 ================= */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // 深拷贝（校验清洗不污染原始数据）
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  // 取消异常：与真正的失败区分开
  class CancelError extends Error {
    constructor() { super('已取消'); this.isCancel = true; }
  }

  // 探测当前部署的图片扩展名：dist 构建后引用为 .webp，开发环境为 .png/.jpg
  function detectImgExt() {
    try {
      if (typeof EMBEDDED_SCRIPT !== 'undefined' && EMBEDDED_SCRIPT.scenes) {
        const s = EMBEDDED_SCRIPT.scenes.find(sc => sc.background);
        if (s && /\.webp$/i.test(s.background)) return 'webp';
      }
    } catch (e) { /* 读不到就按开发环境处理 */ }
    return null; // null = 保留表内原始扩展名
  }
  function withExt(path, ext) {
    return ext ? path.replace(/\.(png|jpg|jpeg)$/i, '.' + ext) : path;
  }

  /* ================= LLM 调用（流式） ================= */
  // 流式 chat：onDelta(累计文本) 实时回调，signal 用于取消
  async function chatStream(apiKey, messages, onDelta, signal) {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        max_tokens: MAX_TOKENS,
        stream: true,
      }),
      signal: signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403) {
        throw new Error('API Key 无效或已过期（HTTP ' + resp.status + '），请检查后重试');
      }
      throw new Error('API 请求失败（HTTP ' + resp.status + '）：' + txt.slice(0, 200));
    }
    // 逐行解析 SSE：data: {...}\n\n ... data: [DONE]
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '', full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // 最后一段可能不完整，留到下一轮
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (delta && delta.content) {
            full += delta.content;
            if (onDelta) onDelta(full);
          }
        } catch (e) { /* 半包 JSON 忽略，等后续行拼齐 */ }
      }
    }
    return full;
  }

  // 调 chat 并抽取 JSON；空返回/坏 JSON 重试，最后一次把错误塞回让模型修复
  // （译自 script_gen.py 的 chat_json）
  async function chatJson(apiKey, userPrompt, onDelta, signal) {
    const messages = [
      { role: 'system', content: SYSTEM_JSON },
      { role: 'user', content: userPrompt },
    ];
    let lastErr = '';
    for (let attempt = 0; attempt < MAX_PARSE_RETRY; attempt++) {
      if (signal && signal.aborted) throw new CancelError();
      const text = await chatStream(apiKey, messages, onDelta, signal);
      if (!text || !text.trim()) { lastErr = '空返回'; continue; }
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { lastErr = '返回中没有 JSON 对象'; continue; }
      try {
        return JSON.parse(m[0]);
      } catch (e) {
        lastErr = 'JSON 解析失败: ' + e.message;
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: '上一个输出不是合法 JSON（' + e.message + '）。请修复后重新只输出 JSON，不要 markdown，不要解释。',
        });
      }
    }
    throw new Error('JSON 生成重试 ' + MAX_PARSE_RETRY + ' 次仍失败：' + lastErr);
  }

  /* ================= prompt 构造（译自 script_gen.py） ================= */
  // 人物卡："名字:性格" → { c1: {...} }，id 机械分配，不让 LLM 编
  function parseChars(charList) {
    const characters = {}, cards = [];
    charList.forEach((c, i) => {
      const cid = 'c' + (i + 1);
      characters[cid] = {
        name: c.name,
        color: CHAR_COLORS[i % CHAR_COLORS.length],
        look: c.desc || '',
        sprites: {}, // 占位，资源映射阶段填实体立绘路径
      };
      cards.push(cid + ' = ' + c.name + '（' + (c.desc || '无描述') + '）');
    });
    return { characters, cards };
  }

  function buildOutlinePrompt(theme, cards, nScenes) {
    return (
      '题材：' + theme + '\n人物卡（id 固定，剧本中 say.who / chars.id 必须用这些 id）：\n' +
      cards.join('\n') +
      '\n\n请为这部文游写分幕大纲，全剧约 ' + nScenes + ' 个场景、2-4 个结局。' +
      '最后一幕的 scenes 里必须包含结局场景（每个结局一个 scene，id 用 s_end_xxx，' +
      'summary 注明是哪个结局）；任何 scene id 都必须出现在大纲中，不得临时新造。' +
      '输出 JSON：{"acts": [{"id": "act1", "title": "...", ' +
      '"scenes": [{"id": "s1_xxx", "summary": "...", ' +
      '"background": "bg/xxx.jpg", "chars": ["c1"], "checkpoint": true}], ' +
      '"flags_introduced": ["flag_xxx"]}], ' +
      '"endings": [{"label": "结局·...", "condition": "favor>=3"}]}'
    );
  }

  function buildScenePrompt(theme, cards, act, nScenes) {
    const sceneIds = (act.scenes || []).map(s => s.id);
    return (
      '题材：' + theme + '\n人物卡：\n' + cards.join('\n') +
      '\n\n本幕大纲：' + JSON.stringify(act) +
      '\n\n请只生成这一幕的 scenes JSON：{"scenes": [...]}，' +
      '必须且只能包含这些 scene id：' + JSON.stringify(sceneIds) + '。' +
      '每个 scene 的 script 建议 5-12 条指令，含对话、set 变量、至少一个 choice 分支；' +
      'choice.options[].goto 与 goto.target 只能指向上面列出的 scene id，' +
      '严禁引用未列出的场景 id（包括所谓 s_end 开头的结局场景——结局也是普通 scene）；' +
      '结局场景就是一个 script 最后一条指令为 end 的普通 scene，' +
      '若本幕是最后一幕，必须包含至少一个这样的结局场景（多结局就多个）。' +
      'background 用 bg/英文小写名.jpg；checkpoint 场景应为剧情关键节点。'
    );
  }

  function buildFixPrompt(errors, scenes) {
    return (
      '下面这部文游剧本的 scenes 校验发现这些错误：\n' +
      errors.map(e => '- ' + e).join('\n') +
      '\n\n请修复后输出完整的 scenes JSON：{"scenes": [...]}。' +
      '只改必须改的地方，保持 scene id 与剧情不变；' +
      '所有 goto/target 必须指向存在的 scene id；' +
      '至少有一个 scene 的 script 以 end 指令收尾。' +
      '\n\n当前 scenes：\n' + JSON.stringify(scenes)
    );
  }

  /* ================= 校验 / 修复（译自 script_gen.py） ================= */
  // 字段白名单清洗 + condition/cond/when → if。返回清洗后的指令或 null
  function normalizeCmd(cmd, warnings, where) {
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      warnings.push(where + ': 指令不是对象，已丢弃');
      return null;
    }
    const t = cmd.type;
    if (CMD_TYPES.indexOf(t) < 0) {
      warnings.push(where + ': 未知指令类型 ' + JSON.stringify(t) + '，已丢弃');
      return null;
    }
    for (const alias of COND_ALIASES) {
      if (alias in cmd && !('if' in cmd)) {
        cmd.if = cmd[alias]; delete cmd[alias];
        warnings.push(where + ': 条件字段 ' + alias + ' 已改写为 if');
      }
    }
    const allowed = CMD_FIELDS[t];
    for (const k of Object.keys(cmd)) {
      if (allowed.indexOf(k) < 0) {
        warnings.push(where + ': 剔除未知字段 ' + t + '.' + k);
        delete cmd[k];
      }
    }
    if (t === 'choice') {
      const opts = [];
      (cmd.options || []).forEach((o, i) => {
        if (!o || typeof o !== 'object' || !o.text) {
          warnings.push(where + ': options[' + i + '] 非法，已丢弃');
          return;
        }
        for (const alias of COND_ALIASES) {
          if (alias in o && !('if' in o)) { o.if = o[alias]; delete o[alias]; }
        }
        for (const k of Object.keys(o)) {
          if (OPTION_FIELDS.indexOf(k) < 0) {
            warnings.push(where + ': 剔除未知选项字段 ' + k);
            delete o[k];
          }
        }
        opts.push(o);
      });
      cmd.options = opts;
    }
    return cmd;
  }

  // scene 级白名单清洗。返回清洗后的 scene 或 null
  function cleanScene(scene, warnings) {
    if (!scene || typeof scene !== 'object' || !scene.id) {
      warnings.push('scene 缺 id，已丢弃');
      return null;
    }
    for (const k of Object.keys(scene)) {
      if (SCENE_FIELDS.indexOf(k) < 0) {
        warnings.push('scene ' + scene.id + ': 剔除未知字段 ' + k);
        delete scene[k];
      }
    }
    const chars = [];
    for (const c of scene.chars || []) {
      if (!c || typeof c !== 'object' || !c.id) {
        warnings.push('scene ' + scene.id + ': 非法 chars 项，已丢弃');
        continue;
      }
      if (POS_VALUES.indexOf(c.pos) < 0) c.pos = 'center';
      if (EFFECT_VALUES.indexOf(c.effect) < 0) c.effect = 'fade';
      const item = {};
      for (const k of ['id', 'pos', 'sprite', 'effect']) if (k in c) item[k] = c[k];
      chars.push(item);
    }
    scene.chars = chars;
    const script = [];
    (scene.script || []).forEach((cmd, i) => {
      const cleaned = normalizeCmd(cmd, warnings, 'scene ' + scene.id + ' 行' + i);
      if (cleaned !== null) script.push(cleaned);
    });
    scene.script = script;
    return scene;
  }

  // say.who / chars.id 必须在 characters 中
  function checkCharRefs(scriptJson) {
    const characters = scriptJson.characters || {};
    const errors = [];
    for (const scene of scriptJson.scenes || []) {
      for (const c of scene.chars || []) {
        if (!(c.id in characters)) {
          errors.push('scene ' + scene.id + ': chars 引用未定义角色 ' + c.id);
        }
      }
      (scene.script || []).forEach((cmd, i) => {
        if (cmd.type === 'say' && !(cmd.who in characters)) {
          errors.push('scene ' + scene.id + ' 行' + i + ': say.who 引用未定义角色 ' + JSON.stringify(cmd.who));
        }
      });
    }
    return errors;
  }

  // 分支连通性：悬空 goto、从首幕可达 end、不可达 scene、循环风险报告
  function checkConnectivity(scriptJson) {
    const scenes = scriptJson.scenes || [];
    const ids = scenes.map(s => s.id);
    const idset = new Set(ids);
    const errors = [], warnings = [];
    if (!scenes.length) return { errors: ['剧本没有 scene'], warnings };

    const edges = {};   // scene_id -> Set(target)
    const endScenes = new Set();
    for (const s of scenes) {
      const sid = s.id;
      const targets = new Set();
      (s.script || []).forEach((cmd, i) => {
        const t = cmd.type;
        if (t === 'goto' && cmd.target) {
          targets.add(cmd.target);
          if (!idset.has(cmd.target)) {
            errors.push('scene ' + sid + ' 行' + i + ': 悬空 goto -> ' + cmd.target);
          }
        } else if (t === 'choice') {
          for (const o of cmd.options || []) {
            if (o.goto) {
              targets.add(o.goto);
              if (!idset.has(o.goto)) {
                errors.push('scene ' + sid + ' choice「' + o.text + '」: 悬空 goto -> ' + o.goto);
              }
            }
          }
        } else if (t === 'end') {
          endScenes.add(sid);
        }
      });
      // 顺序执行：无终止/跳转指令时流向下一 scene
      const flowThrough = !(s.script || []).some(
        c => ['end', 'goto', 'choice'].indexOf(c.type) >= 0 && !c.if);
      if (flowThrough) {
        const idx = ids.indexOf(sid);
        if (idx + 1 < ids.length) targets.add(ids[idx + 1]);
      }
      edges[sid] = targets;
    }

    // BFS 可达性
    const reachable = new Set();
    const stack = [ids[0]];
    while (stack.length) {
      const cur = stack.pop();
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const nx of edges[cur] || []) if (!reachable.has(nx)) stack.push(nx);
    }
    for (const sid of idset) {
      if (!reachable.has(sid)) warnings.push('scene ' + sid + ' 从首幕不可达');
    }
    if (!endScenes.size) errors.push('剧本没有任何 end 指令');
    if (![...endScenes].some(s => reachable.has(s))) errors.push('从首幕不可达任何 end 结局');
    for (const sid of endScenes) {
      if (!reachable.has(sid)) warnings.push('结局场景 ' + sid + ' 不可达');
    }

    // 死循环风险：存在不含 end 的强连通分量（迭代 Tarjan，译自 script_gen.py）
    const index = {}, low = {}, onStack = new Set(), sccStack = [];
    let counter = 0;
    const cyclic = [];
    function strongconnect(v) {
      const work = [[v, (edges[v] || new Set()).values()]];
      index[v] = low[v] = counter++;
      sccStack.push(v); onStack.add(v);
      while (work.length) {
        const top = work[work.length - 1];
        const node = top[0], it = top[1];
        let advanced = false;
        for (const w of it) {
          if (!(w in index)) {
            index[w] = low[w] = counter++;
            sccStack.push(w); onStack.add(w);
            work.push([w, (edges[w] || new Set()).values()]);
            advanced = true;
            break;
          } else if (onStack.has(w)) {
            low[node] = Math.min(low[node], index[w]);
          }
        }
        if (!advanced) {
          work.pop();
          if (work.length) {
            const parent = work[work.length - 1][0];
            low[parent] = Math.min(low[parent], low[node]);
          }
          if (low[node] === index[node]) {
            const scc = [];
            for (;;) {
              const w = sccStack.pop(); onStack.delete(w); scc.push(w);
              if (w === node) break;
            }
            if (scc.length > 1 && !scc.some(s => endScenes.has(s))) cyclic.push(scc);
          }
        }
      }
    }
    for (const sid of ids) if (!(sid in index)) strongconnect(sid);
    for (const scc of cyclic) {
      // SCC 内有出边到外部则玩家可逃出，仅报告
      warnings.push('scene [' + scc.sort().join(', ') + '] 存在循环跳转路径，请确认有逃出分支');
    }
    return { errors, warnings };
  }

  /* ================= 资源映射（生成路径 → 现有素材库） ================= */
  // 关键词打分选背景：语料 = 生成的 background 文件名 + scene id + summary + 题材
  function pickBackground(corpus) {
    const text = (corpus || '').toLowerCase();
    const isNight = /night|evening|dusk|dark|夜|晚|黄昏/.test(text);
    const table = isNight ? BG_NIGHT_TABLE.concat(BG_TABLE) : BG_TABLE;
    let best = null, bestScore = 0;
    for (const item of table) {
      let score = 0;
      for (const kw of item.kw) if (text.indexOf(kw.toLowerCase()) >= 0) score++;
      if (score > bestScore) { bestScore = score; best = item.file; }
    }
    if (!best) best = isNight ? BG_FALLBACK_NIGHT : BG_FALLBACK_DAY;
    return best;
  }

  function pickCg(corpus) {
    const text = (corpus || '').toLowerCase();
    for (const item of CG_TABLE) {
      for (const kw of item.kw) if (text.indexOf(kw.toLowerCase()) >= 0) return item.file;
    }
    return null;
  }

  // 音频库（assets/bgm|sfx，DOVA-SYNDROME 免费可商用）按氛围关键词匹配
  const BGM_TABLE = [
    { kw: ['雨', 'rain', '夜', 'night', '渡', 'ferry', '河'], file: 'bgm/rain_night.mp3' },
    { kw: ['茶', 'tea', '温', 'warm', '棚'], file: 'bgm/teashelter.mp3' },
    { kw: ['铺', 'shop', '灯', 'lantern', '日常', 'daily'], file: 'bgm/shop_warm.mp3' },
    { kw: ['镇', 'town', '街', 'street', '白天', 'day', '市'], file: 'bgm/town_day.mp3' },
    { kw: ['竹', 'bamboo', '林', 'wind', '清'], file: 'bgm/bamboo_wind.mp3' },
    { kw: ['会', 'festival', '典', '庆', '热闹'], file: 'bgm/festival.mp3' },
    { kw: ['紧张', 'tense', '危', 'danger', '追', '疑'], file: 'bgm/tense.mp3' },
    { kw: ['结局', 'ending', '终', '别', '离'], file: 'bgm/ending.mp3' },
  ];
  const SFX_TABLE = [
    { kw: ['雨', 'rain'], file: 'sfx/rain_loop.wav' },
    { kw: ['船', 'boat', '渡', '吱'], file: 'sfx/boat_creak.wav' },
    { kw: ['檐', 'roof', '屋'], file: 'sfx/rain_on_roof.wav' },
    { kw: ['市', 'market', '集', '喧闹'], file: 'sfx/market_noise.wav' },
    { kw: ['剑', 'sword', '刀', '武'], file: 'sfx/sword_whoosh.wav' },
    { kw: ['竹', 'bamboo', '叶', 'rustle'], file: 'sfx/bamboo_rustle.wav' },
    { kw: ['欢呼', 'crowd', '喝彩', 'cheer'], file: 'sfx/crowd_cheer.wav' },
    { kw: ['脚步', 'foot', '走', 'walk'], file: 'sfx/footsteps.wav' },
    { kw: ['门', 'door', '开', '关'], file: 'sfx/door.wav' },
    { kw: ['纸', 'paper', '书', '信'], file: 'sfx/paper.wav' },
    { kw: ['铃', 'chime', '风铃'], file: 'sfx/wind_chime.wav' },
  ];
  function pickFrom(table, corpus) {
    const text = (corpus || '').toLowerCase();
    let best = null, bestScore = 0;
    for (const item of table) {
      let score = 0;
      for (const kw of item.kw) if (text.indexOf(kw.toLowerCase()) >= 0) score++;
      if (score > bestScore) { bestScore = score; best = item.file; }
    }
    return best;
  }
  const pickBgm = c => pickFrom(BGM_TABLE, c);
  const pickSfx = c => pickFrom(SFX_TABLE, c);

  // 把整个剧本的资源引用改写到现有素材库；返回映射日志
  function mapAssets(scriptJson, theme, outline) {
    const ext = detectImgExt();
    const log = [];
    // scene id → 大纲 summary（给背景匹配更多语料）
    const summaryOf = {};
    for (const act of (outline && outline.acts) || []) {
      for (const s of act.scenes || []) summaryOf[s.id] = s.summary || '';
    }

    // 1) 角色：c1..cn → su/shen/tang/mo/wan 五套立绘
    const cids = Object.keys(scriptJson.characters || {});
    cids.forEach((cid, i) => {
      const setName = SPRITE_SETS[i % SPRITE_SETS.length];
      const sprites = {};
      for (const emo of DEFAULT_EMOTIONS) {
        sprites[emo] = withExt('chars/' + setName + '_' + emo + '.png', ext);
      }
      scriptJson.characters[cid].sprites = sprites;
      log.push('角色 ' + scriptJson.characters[cid].name + '（' + cid + '）→ 立绘套装 ' + setName);
    });

    // 2) 场景：背景关键词映射；音频引用移除（素材库暂无 bgm/sfx）
    for (const scene of scriptJson.scenes || []) {
      const corpus = [scene.background || '', scene.id || '', summaryOf[scene.id] || '', theme].join(' ');
      const mapped = pickBackground(corpus);
      if (scene.background !== mapped) {
        log.push('背景 ' + (scene.background || '(无)') + ' → ' + mapped);
      }
      scene.background = withExt(mapped, ext);

      // 音频：关键词映射到现有音频库（DOVA-SYNDROME 免费可商用资源）
      const audioCorpus = corpus + ' ' + (summaryOf[scene.id] || '');
      if (scene.bgm) {
        const bgmSrc = typeof scene.bgm === 'string' ? scene.bgm : scene.bgm.src;
        const m = pickBgm((bgmSrc || '') + ' ' + audioCorpus);
        if (m) {
          scene.bgm = typeof scene.bgm === 'string' ? m : Object.assign({}, scene.bgm, { src: m });
          log.push('BGM ' + (bgmSrc || '(无)') + ' → ' + m);
        } else { delete scene.bgm; log.push('scene ' + scene.id + ': BGM 无匹配，已移除'); }
      }
      if (scene.sfx) {
        const arr = Array.isArray(scene.sfx) ? scene.sfx : [scene.sfx];
        const mappedSfx = arr.map(s => {
          const src = typeof s === 'string' ? s : (s && s.src) || '';
          const m = pickSfx(src + ' ' + audioCorpus);
          return m ? (typeof s === 'string' ? m : Object.assign({}, s, { src: m })) : null;
        }).filter(Boolean);
        if (mappedSfx.length) scene.sfx = mappedSfx;
        else delete scene.sfx;
      }

      // 3) 指令内的图片引用（show / inspect.show.image）→ 现有 CG，匹配不到则丢弃图片
      scene.script = (scene.script || []).filter(cmd => {
        if (cmd.type === 'show') {
          const cg = pickCg((cmd.image || '') + ' ' + (summaryOf[scene.id] || ''));
          if (cg) { cmd.image = withExt(cg, ext); return true; }
          log.push('scene ' + scene.id + ': show 图片 ' + cmd.image + ' 无匹配 CG，已丢弃该指令');
          return false;
        }
        if (cmd.type === 'inspect' && cmd.show && cmd.show.image) {
          const cg = pickCg(cmd.show.image + ' ' + (cmd.show.text || ''));
          if (cg) cmd.show.image = withExt(cg, ext);
          else { delete cmd.show.image; log.push('scene ' + scene.id + ': inspect 图片无匹配 CG，仅保留文字'); }
        }
        return true;
      });
    }
    return log;
  }

  /* ================= 组装（译自 script_gen.py 的 assemble） ================= */
  function assemble(theme, characters, allScenes) {
    return {
      meta: {
        title: theme, author: 'AI工坊', version: '1.0',
        defaults: { text_speed: 25, bgm_volume: 0.5, auto_delay: 1800 },
      },
      characters: characters,
      assets_dir: 'assets/',
      scenes: allScenes,
    };
  }

  /* ================= UI：样式注入 ================= */
  function injectCss() {
    if ($('an-style')) return;
    const style = document.createElement('style');
    style.id = 'an-style';
    style.textContent = `
.an-overlay { position:fixed; inset:0; z-index:200; background:rgba(0,0,0,.8);
  display:flex; align-items:center; justify-content:center; }
.an-panel { background:rgba(10,12,20,.9); border:1px solid #3a4a63; border-radius:.6em;
  padding:1.6em 2em; width:min(92vw,680px); max-height:90vh; overflow:auto; color:#eee;
  font-size:15px; line-height:1.6; }
.an-panel h2 { margin:.2em 0 .8em; font-size:1.3em; }
.an-row { margin:.7em 0; }
.an-row label { display:block; margin-bottom:.3em; opacity:.85; }
.an-input, .an-panel input[type=text], .an-panel input[type=password], .an-panel input[type=number] {
  width:100%; box-sizing:border-box; padding:.45em .6em; background:#0c1120; color:#eee;
  border:1px solid #5a7bb0; border-radius:.4em; font-size:1em; }
.an-hint { font-size:.85em; opacity:.6; margin-top:.25em; }
.an-char-row { display:flex; gap:.5em; margin-bottom:.5em; align-items:center; }
.an-char-row input { flex:1; }
.an-btn { display:inline-block; margin:.3em .3em .3em 0; padding:.55em 1.4em; background:#263652;
  color:#fff; border:1px solid #5a7bb0; border-radius:.4em; cursor:pointer; font-size:1em; }
.an-btn:hover { background:#33497a; }
.an-btn.small { padding:.3em .8em; font-size:.85em; }
.an-btn.danger { border-color:#a05a5a; background:#4a2630; }
.an-btn.danger:hover { background:#6a3340; }
.an-btn:disabled { opacity:.4; cursor:not-allowed; }
.an-actions { margin-top:1em; display:flex; gap:.5em; flex-wrap:wrap; }
.an-log { background:#0a0e18; border:1px solid #2a3a55; border-radius:.4em; padding:.8em 1em;
  margin-top:.8em; max-height:32vh; overflow:auto; font-size:.88em; white-space:pre-wrap; }
.an-log .an-err { color:#ff8080; }
.an-log .an-warn { color:#ffd75e; }
.an-log .an-ok { color:#8fd18f; }
.an-stream { color:#9ab; font-size:.8em; opacity:.8; border-top:1px dashed #2a3a55;
  margin-top:.5em; padding-top:.5em; max-height:12vh; overflow:auto; }
.an-hidden { display:none !important; }
`;
    document.head.appendChild(style);
  }

  /* ================= UI：模态框 ================= */
  const ui = {
    running: false,      // 是否正在生成
    abort: null,         // AbortController
    result: null,        // 生成成功的剧本 JSON
  };

  function log(msg, cls) {
    const el = $('an-log');
    if (!el) return;
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = msg;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // 流式输出预览（只保留末尾，避免刷屏）
  function streamPreview(full) {
    const el = $('an-stream');
    if (!el) return;
    el.textContent = '⟳ ' + full.slice(-300);
    el.scrollTop = el.scrollHeight;
  }

  function buildModal() {
    if ($('an-overlay')) return;
    injectCss();
    const wrap = document.createElement('div');
    wrap.id = 'an-overlay';
    wrap.className = 'an-overlay an-hidden';
    wrap.innerHTML = `
<div class="an-panel">
  <h2>✍ AI 写新故事</h2>
  <div id="an-form">
    <div class="an-row">
      <label>题材（一句话）</label>
      <input type="text" id="an-theme" maxlength="60" placeholder="例：修仙山门悬案 / 深夜便利店奇遇">
    </div>
    <div class="an-row">
      <label>主要角色（2-4 个：名字 + 性格）</label>
      <div id="an-chars"></div>
      <button class="an-btn small" id="an-add-char">+ 添加角色</button>
    </div>
    <div class="an-row">
      <label>场景数（3-8）</label>
      <input type="number" id="an-scenes" min="3" max="8" value="5" style="width:6em">
    </div>
    <div class="an-row">
      <label>阶跃 API Key</label>
      <input type="password" id="an-key" placeholder="只需填一次，本机保存">
      <div class="an-hint">Key 可从 <b>platform.stepfun.com</b> 免费获取；仅保存在本机 localStorage，不会上传到别处。</div>
    </div>
    <div class="an-actions">
      <button class="an-btn" id="an-generate">开始生成</button>
      <button class="an-btn" id="an-close">关闭</button>
    </div>
  </div>
  <div id="an-progress" class="an-hidden">
    <div class="an-actions">
      <button class="an-btn danger" id="an-cancel">取消生成</button>
    </div>
    <div class="an-log" id="an-log"></div>
    <div class="an-stream" id="an-stream"></div>
  </div>
  <div id="an-done" class="an-hidden">
    <div class="an-log" id="an-done-log" style="max-height:20vh"></div>
    <div class="an-actions">
      <button class="an-btn" id="an-play">▶ 开始游戏</button>
      <button class="an-btn" id="an-download">下载剧本 JSON</button>
      <button class="an-btn" id="an-back">返回</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(wrap);

    // 事件绑定
    $('an-close').onclick = close;
    $('an-add-char').onclick = () => { addCharRow(); };
    $('an-generate').onclick = startGenerate;
    $('an-cancel').onclick = cancelGenerate;
    $('an-back').onclick = () => { showPane('form'); };
    $('an-download').onclick = downloadResult;
    $('an-play').onclick = playResult;
    // 初始两个角色行
    addCharRow(); addCharRow();
    // 读取已保存的 key
    $('an-key').value = localStorage.getItem(LS_KEY) || '';
  }

  function addCharRow(name, desc) {
    const box = $('an-chars');
    if (box.children.length >= 4) { log2Form('最多 4 个角色'); return; }
    const row = document.createElement('div');
    row.className = 'an-char-row';
    row.innerHTML =
      '<input type="text" class="an-char-name" maxlength="10" placeholder="名字">' +
      '<input type="text" class="an-char-desc" maxlength="40" placeholder="性格 / 身份" style="flex:2">' +
      '<button class="an-btn small danger" title="删除">×</button>';
    if (name) row.querySelector('.an-char-name').value = name;
    if (desc) row.querySelector('.an-char-desc').value = desc;
    row.querySelector('button').onclick = () => {
      if (box.children.length <= 2) { log2Form('至少保留 2 个角色'); return; }
      box.removeChild(row);
    };
    box.appendChild(row);
  }

  // 表单区的小提示（用 alert 太打断，这里简单闪一下按钮文字）
  function log2Form(msg) {
    const btn = $('an-add-char');
    const old = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = old; }, 1200);
  }

  function showPane(which) {
    $('an-form').classList.toggle('an-hidden', which !== 'form');
    $('an-progress').classList.toggle('an-hidden', which !== 'progress');
    $('an-done').classList.toggle('an-hidden', which !== 'done');
  }

  function open() {
    buildModal();
    $('an-overlay').classList.remove('an-hidden');
    showPane('form');
  }

  function close() {
    if (ui.running) cancelGenerate();
    $('an-overlay').classList.add('an-hidden');
  }

  function cancelGenerate() {
    if (ui.abort) ui.abort.abort();
  }

  /* ================= 生成管线 ================= */
  function readForm() {
    const theme = $('an-theme').value.trim();
    if (!theme) throw new Error('请填写题材');
    const chars = [];
    document.querySelectorAll('#an-chars .an-char-row').forEach(row => {
      const name = row.querySelector('.an-char-name').value.trim();
      const desc = row.querySelector('.an-char-desc').value.trim();
      if (name) chars.push({ name, desc });
    });
    if (chars.length < 2) throw new Error('至少需要 2 个有名字的角色');
    let nScenes = parseInt($('an-scenes').value, 10) || 5;
    nScenes = Math.max(3, Math.min(8, nScenes));
    const key = $('an-key').value.trim();
    if (!key) throw new Error('请填写阶跃 API Key（platform.stepfun.com 免费获取）');
    return { theme, chars, nScenes, key };
  }

  async function startGenerate() {
    let cfg;
    try {
      cfg = readForm();
    } catch (e) { alert(e.message); return; }
    localStorage.setItem(LS_KEY, cfg.key); // key 只存本机

    ui.running = true;
    ui.abort = new AbortController();
    const signal = ui.abort.signal;
    showPane('progress');
    $('an-log').innerHTML = '';
    $('an-stream').textContent = '';

    try {
      const { characters, cards } = parseChars(cfg.chars);

      // 第一步：分幕大纲
      log('【1/3】生成分幕大纲 …');
      const outline = await chatJson(cfg.key, buildOutlinePrompt(cfg.theme, cards, cfg.nScenes), streamPreview, signal);
      const acts = outline.acts || [];
      if (!acts.length) throw new Error('大纲为空，请换个题材描述重试');
      log('大纲共 ' + acts.length + ' 幕：' + acts.map(a => a.title || a.id).join(' / '), 'an-ok');

      // 第二步：逐幕生成 scene
      log('【2/3】逐幕生成场景 …');
      const allScenes = [], allWarnings = [];
      for (let i = 0; i < acts.length; i++) {
        if (signal.aborted) throw new CancelError();
        const act = acts[i];
        log('  第 ' + (i + 1) + '/' + acts.length + ' 幕「' + (act.title || act.id) + '」撰写中 …');
        const data = await chatJson(cfg.key, buildScenePrompt(cfg.theme, cards, act, cfg.nScenes), streamPreview, signal);
        const scenes = data.scenes || (data.id ? [data] : []);
        for (const s of scenes) {
          const cleaned = cleanScene(deepCopy(s), allWarnings);
          if (cleaned) allScenes.push(cleaned);
        }
        log('  第 ' + (i + 1) + ' 幕完成：+' + scenes.length + ' 个场景');
      }
      let scriptJson = assemble(cfg.theme, characters, allScenes);

      // 第三步：校验，失败则把错误清单喂回 LLM 修复（至多 MAX_FIX_ROUND 轮）
      log('【3/3】校验剧本 …');
      let errors = [];
      for (let round = 0; round <= MAX_FIX_ROUND; round++) {
        errors = checkCharRefs(scriptJson);
        const conn = checkConnectivity(scriptJson);
        errors = errors.concat(conn.errors);
        if (!errors.length) break;
        if (round === MAX_FIX_ROUND) break;
        log('校验发现 ' + errors.length + ' 个错误，交给 AI 修复（第 ' + (round + 1) + '/' + MAX_FIX_ROUND + ' 轮）…', 'an-warn');
        errors.slice(0, 8).forEach(e => log('  · ' + e, 'an-warn'));
        const fixed = await chatJson(cfg.key, buildFixPrompt(errors, scriptJson.scenes), streamPreview, signal);
        const fixedScenes = fixed.scenes || [];
        if (fixedScenes.length) {
          const rebuilt = [];
          for (const s of fixedScenes) {
            const cleaned = cleanScene(deepCopy(s), allWarnings);
            if (cleaned) rebuilt.push(cleaned);
          }
          scriptJson = assemble(cfg.theme, characters, rebuilt);
        }
      }
      allWarnings.slice(0, 20).forEach(w => log('[告警] ' + w, 'an-warn'));
      if (errors.length) {
        errors.slice(0, 10).forEach(e => log('[错误] ' + e, 'an-err'));
        throw new Error('校验未通过（修复 ' + MAX_FIX_ROUND + ' 轮后仍有 ' + errors.length + ' 个错误），请重试');
      }
      log('校验通过：' + scriptJson.scenes.length + ' 个场景', 'an-ok');

      // 资源映射：生成路径 → 现有素材库
      log('映射素材库 …');
      const mapLog = mapAssets(scriptJson, cfg.theme, outline);
      mapLog.slice(0, 20).forEach(l => log('  ' + l));

      // 完成：切到结果面板
      ui.result = scriptJson;
      const doneLog = $('an-done-log');
      doneLog.innerHTML = '';
      doneLog.textContent = '✅ 剧本《' + cfg.theme + '》生成完成！共 ' + scriptJson.scenes.length +
        ' 个场景、' + Object.keys(scriptJson.characters).length + ' 个角色。\n' +
        '点「开始游戏」直接开玩，或「下载剧本 JSON」保存到本地。';
      showPane('done');
    } catch (e) {
      if (e.isCancel || (e.name === 'AbortError')) {
        log('⏹ 已取消生成。', 'an-warn');
      } else {
        log('✖ 生成失败：' + e.message, 'an-err');
      }
      // 失败/取消后留在进度页，可直接关闭或重来
      const cancelBtn = $('an-cancel');
      cancelBtn.textContent = '返回';
      cancelBtn.onclick = () => { showPane('form'); cancelBtn.textContent = '取消生成'; cancelBtn.onclick = cancelGenerate; };
    } finally {
      ui.running = false;
      ui.abort = null;
    }
  }

  /* ================= 生成结果：开玩 / 下载 ================= */
  function playResult() {
    if (!ui.result) return;
    if (typeof loadScript !== 'function' || typeof startNewGame !== 'function') {
      alert('未找到引擎入口（loadScript/startNewGame），请确认 ai_gen.js 在 index.html 之后引入');
      return;
    }
    close();
    loadScript(deepCopy(ui.result)); // 引擎全局函数：载入剧本
    startNewGame();                  // 引擎全局函数：直接开玩（会弹出起名框）
  }

  function downloadResult() {
    if (!ui.result) return;
    const blob = new Blob([JSON.stringify(ui.result, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (ui.result.meta.title || 'ai_script') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  /* ================= 导出 ================= */
  window.AutoNovel = { open: open, close: close };
})();
