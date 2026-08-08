/* ============================================================================
 * tsc.js —— 文游·文字脚本编译器（浏览器版）
 *
 * 与 tools/tsc.py 同规则的逐行移植：橙光式纯文本剧本 → 引擎剧本 JSON。
 * 格式见 docs/text_script_format.md。
 *
 * 暴露 window.TextScript = {
 *   compile(text) -> { script, warnings }   // 校验不过 throw Error（带行号中文，多行）
 *   DEMO                                   // 内置示例《灯下问仙》文本脚本
 * }
 * Node 侧（冒烟比对用）：module.exports 同形。
 *
 * 与 Python 版的差异仅在素材解析：浏览器读不了文件系统，裸文件名按
 * 「引擎已加载剧本（script / EMBEDDED_SCRIPT）里引用过的素材清单」做 stem 匹配；
 * 图片默认扩展名按 ai_gen.js 同款 detectImgExt 探测（dist 一律 .webp）。
 * ========================================================================== */
(function () {
'use strict';

var EMOTIONS = ['normal', 'smile', 'angry', 'sad', 'surprise'];
// 已知立绘套装的真实表情清单（按 assets/chars 实际文件核对，与 ai_gen.js SPRITE_SETS 一致）：
// 五套都有标准 5 表情，mo 额外有 shy。表内套装只生成真实存在的 sprites 键，
// 引用缺失表情时引擎 spritePath 自动回退 normal，文件缺失降级剪影，不会破图。
var KNOWN_SETS = {
  su: EMOTIONS,
  shen: EMOTIONS,
  tang: EMOTIONS,
  mo: EMOTIONS.concat(['shy']),
  wan: EMOTIONS
};
var EMO_ALIAS = {
  normal: 'normal', '平常': 'normal', '普通': 'normal', '平静': 'normal',
  smile: 'smile', '微笑': 'smile', '笑': 'smile', '开心': 'smile', '高兴': 'smile',
  angry: 'angry', '生气': 'angry', '怒': 'angry', '愤怒': 'angry',
  sad: 'sad', '难过': 'sad', '悲伤': 'sad', '伤心': 'sad', '哭': 'sad',
  surprise: 'surprise', '惊讶': 'surprise', '吃惊': 'surprise', '震惊': 'surprise',
  shy: 'shy', '害羞': 'shy', '羞涩': 'shy', '脸红': 'shy'
};
var ASSET_PREFIX = { '背景': 'bg', '音乐': 'bgm', '音效': 'sfx', '图': 'cg' };
var ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var hasOwn = function (obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); };

function CompileError(lineno, msg) {
  this.lineno = lineno;
  this.message = '第' + lineno + '行：' + msg;
}
CompileError.prototype = Object.create(Error.prototype);

/* ================= 条件表达式解析（校验用，不求值，不用 eval） ================= */

function ExprError(msg) { this.message = msg; }
ExprError.prototype = Object.create(Error.prototype);

function tokenizeExpr(src) {
  /* 与引擎 index.html tokenize() 等价 */
  var toks = [], i = 0;
  while (i < src.length) {
    var c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    var two = src.substr(i, 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].indexOf(two) >= 0) { toks.push(['op', two]); i += 2; continue; }
    if ('><!()'.indexOf(c) >= 0) { toks.push(['op', c]); i++; continue; }
    if (c === '"' || c === "'") {
      var j = i + 1;
      while (j < src.length && src[j] !== c) j++;
      if (j >= src.length) throw new ExprError('字符串未闭合');
      toks.push(['str', src.slice(i + 1, j)]); i = j + 1; continue;
    }
    var m = src.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (m) { toks.push(['num', m[0]]); i += m[0].length; continue; }
    m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) { toks.push(['id', m[0]]); i += m[0].length; continue; }
    throw new ExprError('无法解析的字符: ' + c);
  }
  return toks;
}

function checkExpr(src) {
  /* 递归下降校验（与引擎 parseExpr 同文法），返回引用的变量名数组。语法不合法抛 ExprError。 */
  var toks = tokenizeExpr(src);
  var pos = 0;
  var varnames = [];
  function peek() { return pos < toks.length ? toks[pos] : null; }
  function eat() { return toks[pos++]; }
  function prim() {
    var tk = eat();
    if (!tk) throw new ExprError('表达式意外结束');
    var t = tk[0], v = tk[1];
    if (t === 'num' || t === 'str') return;
    if (t === 'id') {
      if (v !== 'true' && v !== 'false' && varnames.indexOf(v) < 0) varnames.push(v);
      return;
    }
    if (v === '(') { or_(); if (!peek() || peek()[1] !== ')') throw new ExprError('括号不匹配'); eat(); return; }
    if (v === '!') { prim(); return; }
    throw new ExprError('语法错误：意外的 ' + v);
  }
  function cmp() {
    prim();
    while (peek() && ['==', '!=', '>', '<', '>=', '<='].indexOf(peek()[1]) >= 0) { eat(); prim(); }
  }
  function and_() { cmp(); while (peek() && peek()[1] === '&&') { eat(); cmp(); } }
  function or_() { and_(); while (peek() && peek()[1] === '||') { eat(); and_(); } }
  if (!toks.length) throw new ExprError('条件表达式为空');
  or_();
  if (pos < toks.length) throw new ExprError('表达式有多余内容: ' + peek()[1]);
  return varnames;
}

/* ================= 解析辅助 ================= */

function splitArgs(s, lineno) {
  var out = [], cur = '', q = null;
  for (var k = 0; k < s.length; k++) {
    var ch = s[k];
    if (q) {
      if (ch === q) q = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else cur += ch;
  }
  if (q) throw new CompileError(lineno, '引号未闭合');
  if (cur) out.push(cur);
  return out;
}

/* ================= 素材解析（浏览器版：清单来自已加载剧本的引用） ================= */

function engineScript() {
  try { if (typeof script !== 'undefined' && script && script.scenes) return script; } catch (e) {}
  try { if (typeof EMBEDDED_SCRIPT !== 'undefined' && EMBEDDED_SCRIPT && EMBEDDED_SCRIPT.scenes) return EMBEDDED_SCRIPT; } catch (e) {}
  return null;
}

function detectImgExt() {
  /* 仿 ai_gen.js：dist 里背景一律 .webp */
  try {
    var es = engineScript();
    if (es) {
      var s = es.scenes.find(function (sc) { return sc.background; });
      if (s && /\.webp$/i.test(s.background)) return 'webp';
    }
  } catch (e) {}
  return null;   // null = 保留 .png/.jpg
}

function withImgExt(p) {
  var ext = detectImgExt();
  return ext ? p.replace(/\.(png|jpg|jpeg)$/i, '.' + ext) : p;
}

function collectInventory() {
  /* 从引擎已加载剧本收集引用过的素材路径集合（含真实扩展名） */
  var set = Object.create(null);
  var es = engineScript();
  if (!es) return set;
  function add(p) { if (typeof p === 'string' && p.indexOf('/') > 0) set[p] = true; }
  var chars = es.characters || {};
  Object.keys(chars).forEach(function (cid) {
    var sp = chars[cid].sprites || {};
    Object.keys(sp).forEach(function (k) {
      var v = sp[k];
      if (typeof v === 'string') add(v);
      else if (v && typeof v === 'object') Object.keys(v).forEach(function (k2) { add(v[k2]); });
    });
  });
  (es.scenes || []).forEach(function (sc) {
    add(sc.background);
    if (sc.bgm) add(typeof sc.bgm === 'object' ? sc.bgm.src : sc.bgm);
    var sfx = sc.sfx ? (Array.isArray(sc.sfx) ? sc.sfx : [sc.sfx]) : [];
    sfx.forEach(function (it) { add(it && typeof it === 'object' ? it.src : it); });
    (sc.script || []).forEach(function (cmd) {
      if (cmd.type === 'show') add(cmd.image);
      else if (cmd.type === 'inspect' && cmd.show) add(cmd.show.image);
    });
  });
  return set;
}

function makeResolver() {
  var inventory = collectInventory();
  var hasInv = Object.keys(inventory).length > 0;
  var byStem = Object.create(null);
  Object.keys(inventory).forEach(function (p) {
    var stem = p.replace(/\.[^.]+$/, '');
    if (!(stem in byStem)) byStem[stem] = p;
  });

  return function resolve(kind, value, lineno, warnings) {
    var sub = ASSET_PREFIX[kind];
    var defaultExt = kind === '音乐' ? '.mp3' : kind === '音效' ? '.wav' : (detectImgExt() ? '.webp' : '.jpg');
    if (value === 'none' && kind === '背景') return 'none';
    if (value.indexOf('/') >= 0) {                    // 已带目录前缀，原样保留
      if (hasInv && !inventory[value])
        warnings.push('第' + lineno + '行：素材 ' + value + ' 未在已加载剧本的素材清单中出现，引擎将降级占位');
      return value;
    }
    var full = sub + '/' + value;
    if (/\./.test(value)) {                           // 自带扩展名
      if (hasInv && !inventory[full])
        warnings.push('第' + lineno + '行：素材 ' + full + ' 未在已加载剧本的素材清单中出现，引擎将降级占位');
      return full;
    }
    if (byStem[full]) return byStem[full];            // stem 命中清单（拿到真实扩展名）
    warnings.push('第' + lineno + '行：素材 ' + full + ' 未找到，按默认扩展名输出，引擎将降级占位');
    return full + defaultExt;
  };
}

/* ================= 编译器主体 ================= */

function Compiler(text) {
  this.lines = text.split('\n');
  this.errors = [];
  this.warnings = [];
  this.resolve = makeResolver();
  this.title = null;
  this.author = null;
  this.characters = Object.create(null);   // id -> {name, color, prefix, line}（null 原型防 'constructor' 类键名误判）
  this.name2id = Object.create(null);
  this.attrs = Object.create(null);        // id -> {name, init, min, max, bar, line}
  this.scenes = [];
  this.cur = null;
}

Compiler.prototype.err = function (lineno, msg) {
  this.errors.push('第' + lineno + '行：' + msg);
};

Compiler.prototype.compile = function () {
  for (var n = 0; n < this.lines.length; n++) {
    var line = this.lines[n].trim();
    if (!line || line.indexOf('//') === 0) continue;
    try {
      this.parseLine(n + 1, line);
    } catch (e) {
      if (e instanceof CompileError) this.errors.push(e.message);
      else throw e;
    }
  }
  if (this.cur !== null) {
    this.flushChoice();
    this.scenes.push(this.cur);
    this.cur = null;
  }
  this.validate();
  if (this.errors.length) {
    var err = new Error(this.errors.join('\n'));
    err.errors = this.errors.slice();
    err.warnings = this.warnings.slice();
    throw err;
  }
  return { script: this.assemble(), warnings: this.warnings.slice() };
};

/* ---------- 行分派 ---------- */
Compiler.prototype.parseLine = function (n, line) {
  if (line[0] === '#') {
    this.parseMeta(n, line);
  } else if (line.indexOf('@角色') === 0 && (line.length === 3 || line[3] === ' ' || line[3] === '\t')) {
    if (this.scenes.length || this.cur !== null)
      throw new CompileError(n, '@角色 定义必须放在第一个 ==场景 之前（头部）');
    this.parseCharDef(n, line);
  } else if (line.indexOf('%属性') === 0) {
    if (this.scenes.length || this.cur !== null)
      throw new CompileError(n, '%属性 定义必须放在第一个 ==场景 之前（头部）');
    this.parseAttrDef(n, line);
  } else if (line.indexOf('==') === 0) {
    this.parseSceneHead(n, line);
  } else {
    if (this.cur === null) throw new CompileError(n, '这行不在任何场景内（场景用 ==场景 开头）');
    this.parseBody(n, line);
  }
};

/* ---------- 头部 ---------- */
Compiler.prototype.parseMeta = function (n, line) {
  var toks = splitArgs(line.slice(1).trim(), n);
  if (toks.length < 2) throw new CompileError(n, '头部行格式：# 标题 xxx 或 # 作者 xxx');
  var key = toks[0], val = toks.slice(1).join(' ');
  if (key === '标题') this.title = val;
  else if (key === '作者') this.author = val;
  else throw new CompileError(n, '未知的头部字段 "' + key + '"（只支持 标题/作者）');
};

Compiler.prototype.parseCharDef = function (n, line) {
  var toks = splitArgs(line.slice(3).trim(), n);
  if (toks.length < 3) throw new CompileError(n, '@角色 格式：@角色 <id> <显示名> <颜色> [立绘=<前缀>]');
  var cid = toks[0], name = toks[1], color = toks[2];
  if (!ID_RE.test(cid)) throw new CompileError(n, '角色 id "' + cid + '" 只能含英文字母/数字/下划线');
  if (cid in this.characters)
    throw new CompileError(n, '角色 id "' + cid + '" 重复定义（首次在第' + this.characters[cid].line + '行）');
  if (name in this.name2id)
    throw new CompileError(n, '角色显示名 "' + name + '" 与角色 ' + this.name2id[name] + ' 重复');
  var prefix = cid;
  for (var i = 3; i < toks.length; i++) {
    if (toks[i].indexOf('立绘=') === 0) prefix = toks[i].slice(3);
    else throw new CompileError(n, '@角色 未知参数 "' + toks[i] + '"（只支持 立绘=<前缀>）');
  }
  if (color[0] !== '#') throw new CompileError(n, '颜色 "' + color + '" 应为 #RRGGBB 形式');
  this.characters[cid] = { name: name, color: color, prefix: prefix, line: n };
  this.name2id[name] = cid;
};

Compiler.prototype.parseAttrDef = function (n, line) {
  var toks = splitArgs(line.slice(3).trim(), n);
  if (toks.length < 6) throw new CompileError(n, '%属性 格式：%属性 <id> <显示名> <初值> <最小> <最大> <颜色>');
  var aid = toks[0], name = toks[1];
  if (!ID_RE.test(aid)) throw new CompileError(n, '属性 id "' + aid + '" 只能含英文字母/数字/下划线');
  if (aid in this.attrs)
    throw new CompileError(n, '属性 id "' + aid + '" 重复定义（首次在第' + this.attrs[aid].line + '行）');
  var init = parseFloat(toks[2]), lo = parseFloat(toks[3]), hi = parseFloat(toks[4]);
  if (isNaN(init) || isNaN(lo) || isNaN(hi))
    throw new CompileError(n, '%属性 的 初值/最小/最大 必须是数字：' + toks[2] + ' ' + toks[3] + ' ' + toks[4]);
  this.attrs[aid] = { name: name, init: init, min: lo, max: hi, bar: toks[5], line: n };
};

/* ---------- 场景头 ---------- */
Compiler.prototype.parseSceneHead = function (n, line) {
  var toks = splitArgs(line.slice(2).trim(), n);
  if (toks.length && toks[0] === '场景') toks = toks.slice(1);
  if (!toks.length) throw new CompileError(n, '==场景 缺少场景 id');
  var sid = toks[0];
  if (!ID_RE.test(sid)) throw new CompileError(n, '场景 id "' + sid + '" 只能含英文字母/数字/下划线');
  for (var i = 0; i < this.scenes.length; i++)
    if (this.scenes[i].id === sid)
      throw new CompileError(n, '场景 id "' + sid + '" 重复定义（首次在第' + this.scenes[i]._line + '行）');
  var scene = { id: sid, script: [], _line: n };
  for (i = 1; i < toks.length; i++) {
    var t = toks[i];
    if (t === '存档点') { scene.checkpoint = true; continue; }
    if (t.indexOf('=') < 0)
      throw new CompileError(n, '场景参数 "' + t + '" 无法识别（支持 背景=/音乐=/音效=/存档点/进入条件=/条件跳转=）');
    var eq = t.indexOf('=');
    var key = t.slice(0, eq), val = t.slice(eq + 1);
    if (key === '背景') scene.background = this.resolve('背景', val, n, this.warnings);
    else if (key === '音乐') scene.bgm = this.resolve('音乐', val, n, this.warnings);
    else if (key === '音效') {
      var items = val.split(',').filter(Boolean).map(function (v) {
        return this.resolve('音效', v, n, this.warnings);
      }, this);
      if (!items.length) throw new CompileError(n, '音效= 后至少给一个音效文件');
      scene.sfx = items.length === 1 ? items[0] : items;
    } else if (key === '进入条件') {
      this.guardExpr(n, val);
      scene.require = val;
    } else if (key === '条件跳转') {
      scene.require_else = val;
      scene._require_else_line = n;
    } else throw new CompileError(n, '未知场景参数 "' + key + '="');
  }
  if ('require_else' in scene && !('require' in scene))
    throw new CompileError(n, '条件跳转 必须与 进入条件 一起使用');
  if (this.cur !== null) {
    this.flushChoice();
    this.scenes.push(this.cur);
  }
  this.cur = scene;
};

/* ---------- 场景体 ---------- */
Compiler.prototype.parseBody = function (n, line) {
  if (line[0] === '?') {
    this.flushChoice();
    this.cur._pending_choice = { type: 'choice', options: [], _line: n };
    return;
  }
  if (line[0] === '>') {
    var ch = this.cur._pending_choice;
    if (!ch) throw new CompileError(n, '选项行 > 必须跟在 ? 行之后');
    ch.options.push(this.parseOption(n, line.slice(1).trim()));
    return;
  }
  this.flushChoice();
  if (line[0] === '@') {
    this.parseStation(n, line);
  } else if (line.indexOf('!set') === 0) {
    this.cur.script.push({ type: 'set', vars: this.parseSetOps(n, line.slice(4).trim()), _line: n });
  } else if (line.indexOf('!show') === 0) {
    var rest = line.slice(5).trim();
    if (!rest) throw new CompileError(n, '!show 缺少 CG 文件名');
    this.cur.script.push({ type: 'show', image: this.resolve('图', rest, n, this.warnings), _line: n });
  } else if (line.indexOf('!调查') === 0) {
    this.parseInspect(n, line.slice(3).trim());
  } else if (line.indexOf('->') === 0) {
    this.parseGoto(n, line.slice(2).trim());
  } else if (line.indexOf('::结局') === 0) {
    var label = line.slice(4).trim();
    if (!label) throw new CompileError(n, '::结局 缺少结局名');
    this.cur.script.push({ type: 'end', label: label, _line: n });
  } else {
    this.parseText(n, line);
  }
};

Compiler.prototype.flushChoice = function () {
  var ch = this.cur._pending_choice;
  if (ch) {
    delete this.cur._pending_choice;
    if (!ch.options.length) this.err(ch._line, '? 选项块至少需要一个 > 选项');
    this.cur.script.push(ch);
  }
};

/* ---------- 选项 ---------- */
Compiler.prototype.parseOption = function (n, s) {
  var opt = { _line: n };
  var at = s.lastIndexOf('->');
  if (at >= 0) {                                        // 1) 尾部 -> 目标
    var target = s.slice(at + 2).trim();
    if (!target) throw new CompileError(n, '-> 后缺少目标场景 id');
    opt.goto = target;
    s = s.slice(0, at).trim();
  }
  var m = s.match(/\{([^{}]*)\}/);                      // 2) {变量操作}
  if (m) {
    var ops = this.trySetOps(m[1]);
    if (ops === null)
      throw new CompileError(n, '选项的 {...} 变量操作无法解析：{' + m[1] + '}' +
        '（{变量} 插值只用于对白/旁白文本，选项里 {} 是变量操作）');
    opt.set = ops;
    s = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
  }
  m = s.match(/\[([^\[\]]*)\]/);                        // 3) [条件]
  if (m) {
    var cond = m[1].trim();
    this.guardExpr(n, cond, '选项条件');
    opt.if = cond;
    opt._cond_vars = checkExpr(cond);
    s = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
  }
  if (!s) throw new CompileError(n, '选项缺少文本');
  opt.text = s;
  return opt;
};

/* ---------- 站位 ---------- */
Compiler.prototype.parseStation = function (n, line) {
  var toks = splitArgs(line.slice(1).trim(), n);
  if (!toks.length) throw new CompileError(n, '@ 站位行缺少角色 id');
  var cid = toks[0];
  if (cid === '角色') throw new CompileError(n, '@角色 定义必须放在头部（第一个 ==场景 之前）');
  if (!(cid in this.characters))
    throw new CompileError(n, '未定义的角色 "' + cid + '"（请先在头部用 @角色 定义）');
  var entry = { id: cid, _line: n };
  for (var i = 1; i < toks.length; i++) {
    var t = toks[i];
    var emo = hasOwn(EMO_ALIAS, t) ? EMO_ALIAS[t] : null;
    if (emo) entry.sprite = emo;
    else if (t === 'left' || t === 'center' || t === 'right') entry.pos = t;
    else if (/^\d*\.?\d+(\s*,\s*\d*\.?\d+){2}$/.test(t)) {
      var xyz = t.split(',').map(function (v) { return parseFloat(v); });
      entry.x = xyz[0]; entry.y = xyz[1]; entry.scale = xyz[2];
    } else throw new CompileError(n, '站位参数 "' + t + '" 无法识别（表情/left/center/right/x,y,scale）');
  }
  if (!('pos' in entry) && !('x' in entry)) entry.pos = 'center';
  if (!this.cur.chars) this.cur.chars = [];
  this.cur.chars.push(entry);
};

/* ---------- set 变量操作 ---------- */
Compiler.prototype.trySetOps = function (s) {
  /* 'favor+5 gold=100 flag=1' -> {favor:'favor+5',gold:100,flag:1}；无法解析返回 null */
  s = s.replace(/，/g, ',');
  var toks = s.trim().split(/[\s,]+/).filter(Boolean);
  if (!toks.length) return null;
  var out = Object.create(null);
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i];
    var m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)([+-])(\d+(?:\.\d+)?)$/);
    if (m) { out[m[1]] = m[1] + m[2] + m[3]; continue; }
    m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
    if (m) {
      var v = m[2];
      if (/^-?\d+(\.\d+)?$/.test(v)) out[m[1]] = v.indexOf('.') >= 0 ? parseFloat(v) : parseInt(v, 10);
      else if (v === 'true' || v === 'false') out[m[1]] = v === 'true';
      else {
        try { checkExpr(v); } catch (e) { return null; }   // 表达式赋值：原样交给引擎求值
        out[m[1]] = v;
      }
      continue;
    }
    return null;
  }
  return out;
};

Compiler.prototype.parseSetOps = function (n, s) {
  var ops = this.trySetOps(s);
  if (ops === null)
    throw new CompileError(n, '变量操作无法解析：' + s + '（支持 favor+5 / gold=100 / flag=1）');
  return ops;
};

/* ---------- 调查 ---------- */
Compiler.prototype.parseInspect = function (n, s) {
  var m = s.match(/^(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*([\s\S]*)$/);
  if (!m) throw new CompileError(n, '!调查 格式：!调查 x,y,w,h 图=xxx 文=xxx（x,y,w,h 为 0-1 视口比例）');
  var cmd = { type: 'inspect', x: parseFloat(m[1]), y: parseFloat(m[2]), w: parseFloat(m[3]), h: parseFloat(m[4]), _line: n };
  var rest = m[5].trim();
  var show = {};
  var mt = rest.match(/文=([\s\S]*)$/);
  if (mt) { show.text = mt[1].trim(); rest = rest.slice(0, mt.index).trim(); }
  var mi = rest.match(/图=(\S+)/);
  if (mi) {
    show.image = this.resolve('图', mi[1], n, this.warnings);
    rest = (rest.slice(0, mi.index) + rest.slice(mi.index + mi[0].length)).trim();
  }
  if (rest) throw new CompileError(n, '!调查 无法识别的参数：' + rest);
  if (show.text !== undefined || show.image !== undefined) cmd.show = show;
  this.cur.script.push(cmd);
};

/* ---------- 跳转 ---------- */
Compiler.prototype.parseGoto = function (n, s) {
  var m = s.match(/^(\S+)(?:\s*\[([^\[\]]*)\])?\s*$/);
  if (!m) throw new CompileError(n, '-> 跳转格式：-> 场景id [条件]');
  var cmd = { type: 'goto', target: m[1], _line: n };
  if (m[2] !== undefined) {
    var cond = m[2].trim();
    this.guardExpr(n, cond);
    cmd.if = cond;
  }
  this.cur.script.push(cmd);
};

/* ---------- 旁白 / 对白 ---------- */
Compiler.prototype.parseText = function (n, line) {
  var cond = null;
  var m = line.match(/\[([^\[\]]*)\]\s*$/);
  if (m) {
    cond = m[1].trim();
    this.guardExpr(n, cond);
    line = line.slice(0, m.index).trim();
  }
  m = line.match(/^([^:：]{1,20}?)(?:[（(]([^）)]*)[）)])?[:：]([\s\S]*)$/);
  if (m && m[3].trim()) {
    var speaker = m[1].trim(), emo = m[2], text = m[3].trim();
    var cid = hasOwn(this.characters, speaker) ? speaker
      : (hasOwn(this.name2id, speaker) ? this.name2id[speaker] : undefined);
    if (cid !== undefined) {
      var cmd = { type: 'say', who: cid, text: text, _line: n };
      if (emo) {
        var e = hasOwn(EMO_ALIAS, emo.trim()) ? EMO_ALIAS[emo.trim()] : null;
        if (!e) throw new CompileError(n, '未知表情 "' + emo + '"（支持 ' + EMOTIONS.join('、') + '、shy 及中文别名）');
      }
      if (cond !== null) cmd.if = cond;
      this.cur.script.push(cmd);
      return;
    }
    if (emo !== undefined) throw new CompileError(n, '未定义的角色 "' + speaker + '"（请先在头部用 @角色 定义）');
    /* 无括号且不是角色名：按含冒号的旁白处理 */
  }
  if (!line) throw new CompileError(n, '空文本行');
  var cmd2 = { type: 'narrate', text: line, _line: n };
  if (cond !== null) cmd2.if = cond;
  this.cur.script.push(cmd2);
};

/* ---------- 表达式守卫 ---------- */
Compiler.prototype.guardExpr = function (n, src, context) {
  try {
    checkExpr(src);
  } catch (e) {
    throw new CompileError(n, (context || '条件表达式') + '语法错误：' + src + '（' + e.message + '）');
  }
};

/* ---------- 全局校验 ---------- */
Compiler.prototype.validate = function () {
  var self = this;
  if (!this.title) this.errors.push('缺少标题：请在头部写 # 标题 xxx');
  if (!this.scenes.length) {
    this.errors.push('剧本没有任何场景（==场景 开头）');
    return;
  }
  var ids = Object.create(null);
  this.scenes.forEach(function (sc) { ids[sc.id] = true; });

  /* 1) 场景引用 */
  this.scenes.forEach(function (sc) {
    var ref = sc.require_else;
    if (ref && !(ref in ids))
      self.err(sc._require_else_line, '条件跳转 指向未定义的场景 "' + ref + '"');
    sc.script.forEach(function (cmd) {
      if (cmd.type === 'goto' && !(cmd.target in ids))
        self.err(cmd._line, '-> 跳转指向未定义的场景 "' + cmd.target + '"');
      if (cmd.type === 'choice')
        cmd.options.forEach(function (o) {
          if ('goto' in o && !(o.goto in ids))
            self.err(o._line, '选项 -> 指向未定义的场景 "' + o.goto + '"');
        });
    });
  });

  if (!this.errors.length) {
    /* 2) 场景收尾：执行不能跑出场景末尾（否则游戏卡死） */
    this.scenes.forEach(function (sc) {
      if (!sc.script.length) {
        self.err(sc._line, '场景 "' + sc.id + '" 内容为空');
        return;
      }
      var safe = false;
      for (var i = sc.script.length - 1; i >= 0; i--) {
        var cmd = sc.script[i];
        if (cmd.type === 'end') safe = true;
        else if (cmd.type === 'goto') { if (!('if' in cmd)) safe = true; }
        else if (cmd.type === 'choice') {
          if (cmd.options.length && cmd.options.every(function (o) { return 'goto' in o; })) safe = true;
        }
      }
      if (!safe)
        self.err(sc._line, '场景 "' + sc.id + '" 可能执行到末尾后卡死：请以 -> 跳转、' +
          '::结局 或「所有选项都带 ->」的选项块收尾');
    });
  }

  if (!this.errors.length) {
    /* 3) 结局可达性：从第一个场景出发 BFS */
    var adj = Object.create(null);
    this.scenes.forEach(function (sc) { adj[sc.id] = []; });
    this.scenes.forEach(function (sc, i) {
      function link(t) { if (t in ids && adj[sc.id].indexOf(t) < 0) adj[sc.id].push(t); }
      if (sc.require_else) link(sc.require_else);
      else if (sc.require && i + 1 < self.scenes.length) link(self.scenes[i + 1].id);
      sc.script.forEach(function (cmd) {
        if (cmd.type === 'goto') link(cmd.target);
        else if (cmd.type === 'choice') cmd.options.forEach(function (o) { if ('goto' in o) link(o.goto); });
      });
    });
    var seen = Object.create(null), stack = [this.scenes[0].id];
    while (stack.length) {
      var cur = stack.pop();
      if (cur in seen) continue;
      seen[cur] = true;
      (adj[cur] || []).forEach(function (t) { if (!(t in seen)) stack.push(t); });
    }
    var ends = [];
    this.scenes.forEach(function (sc) {
      if (sc.id in seen)
        sc.script.forEach(function (cmd) { if (cmd.type === 'end') ends.push(cmd.label); });
    });
    if (!ends.length) this.errors.push('结局可达性校验失败：从第一个场景出发走不到任何 ::结局');
    this.scenes.forEach(function (sc) {
      if (!(sc.id in seen)) self.warnings.push('场景 "' + sc.id + '" 从入口不可达（死场景）');
    });
  }

  /* 4) 选项条件变量告警（未在 %属性 定义） */
  this.scenes.forEach(function (sc) {
    sc.script.forEach(function (cmd) {
      if (cmd.type !== 'choice') return;
      cmd.options.forEach(function (o) {
        (o._cond_vars || []).forEach(function (v) {
          if (!(v in self.attrs))
            self.warnings.push('第' + o._line + '行：选项条件引用的变量 "' + v + '" 未在 %属性 中定义（运行时按 0 处理）');
        });
      });
    });
  });

  /* 5) 定义未使用告警 */
  var usedChars = Object.create(null);
  this.scenes.forEach(function (sc) {
    (sc.chars || []).forEach(function (c) { usedChars[c.id] = true; });
    sc.script.forEach(function (cmd) { if (cmd.type === 'say') usedChars[cmd.who] = true; });
  });
  Object.keys(this.characters).forEach(function (cid) {
    if (!(cid in usedChars))
      self.warnings.push('第' + self.characters[cid].line + '行：角色 "' + cid + '"（' + self.characters[cid].name + '）定义后从未出场');
  });
  var usedVars = Object.create(null);
  this.scenes.forEach(function (sc) {
    sc.script.forEach(function (cmd) {
      if (cmd.type === 'set') Object.keys(cmd.vars).forEach(function (k) { usedVars[k] = true; });
      else if (cmd.type === 'choice')
        cmd.options.forEach(function (o) { Object.keys(o.set || {}).forEach(function (k) { usedVars[k] = true; }); });
    });
  });
  Object.keys(this.attrs).forEach(function (aid) {
    if (!(aid in usedVars))
      self.warnings.push('第' + self.attrs[aid].line + '行：属性 "' + aid + '"（' + self.attrs[aid].name + '）从未被修改');
  });
};

/* ---------- 输出 ---------- */
Compiler.prototype.assemble = function () {
  function num(v) { return v === Math.floor(v) ? Math.floor(v) : v; }
  function clean(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) { if (k[0] !== '_') out[k] = obj[k]; });
    return out;
  }
  var attrs = {};
  var self = this;
  Object.keys(this.attrs).forEach(function (aid) {
    var a = self.attrs[aid];
    attrs[aid] = { name: a.name, init: num(a.init), min: num(a.min), max: num(a.max), bar: a.bar };
  });
  var chars = {};
  Object.keys(this.characters).forEach(function (cid) {
    var c = self.characters[cid];
    var sprites = {};
    if (hasOwn(KNOWN_SETS, c.prefix)) {
      // 已知套装：只生成真实存在的表情键（缺表情时引擎回退 normal，不会破图）
      KNOWN_SETS[c.prefix].forEach(function (e) {
        sprites[e] = withImgExt('chars/' + c.prefix + '_' + e + '.png');
      });
    } else {
      // 自定义前缀：标准 5 表情 + 脚本站位里实际用到的额外表情（如 shy）；
      // 文件是否存在无法验证，缺失时引擎降级剪影
      EMOTIONS.forEach(function (e) { sprites[e] = withImgExt('chars/' + c.prefix + '_' + e + '.png'); });
      self.scenes.forEach(function (sc) {
        (sc.chars || []).forEach(function (ch) {
          if (ch.id === cid && ch.sprite && !hasOwn(sprites, ch.sprite))
            sprites[ch.sprite] = withImgExt('chars/' + c.prefix + '_' + ch.sprite + '.png');
        });
      });
    }
    chars[cid] = { name: c.name, color: c.color, sprites: sprites };
  });
  var scenes = this.scenes.map(function (sc) {
    var out = clean(sc);
    out.chars = (sc.chars || []).map(clean);
    if (!out.chars.length) delete out.chars;
    out.script = sc.script.map(function (cmd) {
      var c = clean(cmd);
      if (c.type === 'choice') c.options = c.options.map(clean);
      return c;
    });
    return out;
  });
  var meta = { title: this.title, author: this.author || '', version: '1.0',
    defaults: { text_speed: 25, bgm_volume: 0.5, auto_delay: 1800 } };
  return { meta: meta, attrs: attrs, characters: chars, assets_dir: 'assets/', scenes: scenes };
};

/* ================= 内置示例（与 demo_gl/scripts/demo_branch.txt 一致） ================= */

var DEMO = `// ============================================================
// 灯下问仙 · 文字脚本实战示例
// 两条分支线（放灯线 / 闭关线）+ 数值门控选项 + require 场景门 + 四结局
// 编译：python tools/tsc.py scripts/demo_branch.txt -o scripts/demo_branch.json
// ============================================================
# 标题 灯下问仙
# 作者 文游工坊

@角色 su 苏璃 #FFB6C1 立绘=su
@角色 shen 沈青 #87CEEB 立绘=shen
@角色 tang 阿棠 #E8C47E 立绘=tang
@角色 wan 掌门 #DDA0DD 立绘=wan
@角色 mo 莫师兄 #98FB98 立绘=mo

%属性 favor 苏璃好感 0 0 100 #FFB6C1
%属性 xiuwei 修为 0 0 100 #87CEEB

==场景 s1_town 背景=town_day 音乐=town_day 音效=wind_chime 存档点
@su normal center
你回到灯溪镇那天，风里都是灯油的味道。三年了，山门试炼就在今夜。
苏璃(微笑): 阿灯！三年不见，你总算回来啦！
苏璃(惊讶): 你怀里……还揣着那只没做完的兔子灯？
离试炼只剩一个下午。你打算去哪儿？
?
> 陪苏璃放灯 {favor+6} -> s2_lantern
> 去竹林闭关 {xiuwei+15} -> s2_bamboo
> 直接闯山门 [xiuwei>=20] -> s3_test

==场景 s2_lantern 背景=lantern_shop 音乐=shop_warm
@su smile left
灯笼铺里，苏璃把竹骨一根根剖开，灯影在她指尖摇晃。
苏璃(微笑): 帮我拉住灯口，别动。扎歪了你赔。
你看着她低垂的睫毛，忽然觉得这三年像一阵风。
!调查 0.42,0.62,0.16,0.18 图=teacup 文=粗陶茶盏，盏底有一道旧磕痕，是三年前你失手磕的。
?
> 买下那只兔子灯送她 [favor>=5] {favor+6} -> s3_test
> 默默离开 -> s3_test

==场景 s2_bamboo 背景=bamboo 音乐=bamboo_wind 音效=bamboo_rustle
@shen normal right
竹林深处，沈青收剑而立，落叶在她肩头停了一瞬。
沈青: 闭关三日，可有长进？
沈青(生气): 拔剑。让我看看你这三年没偷懒。
!show sword_light
一剑过后，竹梢齐齐断了一片。
?
> 与沈青再切磋一轮 [xiuwei>=10] {xiuwei+10} -> s3_test
> 下山赴试 -> s3_test

==场景 s3_test 背景=bamboo_night 音乐=tense 存档点 进入条件="xiuwei>=20 || favor>=10" 条件跳转=s3_fallback
@wan normal center
@mo normal left
山门试炼，一剑问心。掌门端坐云台之上，莫师兄侍立一旁。
掌门: 来者，报上你的道。
你如今的修为是{xiuwei}，苏璃对你的好感是{favor}。
?
> 拔剑问天 [xiuwei>=25] -> s_end_sword
> 与苏璃归隐灯下 [favor>=12] -> s_end_love
> 拜入山门修行 -> s_end_join

==场景 s3_fallback 背景=teashelter_night 音乐=teashelter
@tang normal center
试炼落第，山门的灯在你身后一盏盏熄了。山脚下的茶棚还亮着一盏。
阿棠(微笑): 客官，进来喝杯热茶吧，山里风大。
你接过茶盏，热气氤氲里忽然觉得，修仙这件事，好像也不着急。
::结局 归隐茶棚

==场景 s_end_sword 背景=bridge_sunset 音乐=ending 音效=sword_whoosh
@mo surprise left
!show sword_light
莫师兄(惊讶): 一剑……天门真的开了！
云海翻涌，霞光万道。你收剑入鞘，山风猎猎。
::结局 剑开天门

==场景 s_end_love 背景=festival_night 音乐=festival 音效=crowd_cheer
@su smile center
上元灯火如昼，那只兔子灯终于做完了。
苏璃(微笑): 这一次，不许再走啦。
满城灯火里，你牵住了她的手。
::结局 灯火良缘

==场景 s_end_join 背景=town_day 音乐=ending
山门晨钟暮鼓，从此青灯相伴。
偶尔下山，你会给灯溪镇捎一包新茶。
::结局 青灯问道
`;

/* ================= 导出入口 ================= */

function compile(text) {
  var comp = new Compiler(text.replace(/^﻿/, ''));   // 剥 BOM
  return comp.compile();
}

var api = { compile: compile, DEMO: DEMO };
if (typeof window !== 'undefined') window.TextScript = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;

})();
