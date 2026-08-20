#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tsc.py —— 文游·文字脚本编译器（Text Script Compiler）

把橙光风格的纯文本剧本（格式见 docs/text_script_format.md）编译成
引擎剧本 JSON（schema 见 README.md）。

用法（从 demo_gl 运行）：
  python tools/tsc.py scripts/剧本.txt -o scripts/剧本.json   # 编译
  python tools/tsc.py scripts/剧本.txt --check                # 只校验不写盘
  python tools/tsc.py --demo                                  # 打印内置示例文本

编译期校验：未定义场景引用 / 未定义角色 / 条件表达式语法（内置递归下降
解析器，不用 eval）/ 结局可达性 / 场景收尾卡死检测；选项条件里引用未在
%属性 定义的变量仅告警。错误带行号，中文。
"""
import argparse
import json
import os
import re
import sys

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_ROOT = os.path.dirname(TOOLS_DIR)            # demo_gl/
ASSETS_DIR = os.path.join(DEMO_ROOT, 'assets')

EMOTIONS = ('normal', 'smile', 'angry', 'sad', 'surprise')
EMO_ALIAS = {
    'normal': 'normal', '平常': 'normal', '普通': 'normal', '平静': 'normal',
    'smile': 'smile', '微笑': 'smile', '笑': 'smile', '开心': 'smile', '高兴': 'smile',
    'angry': 'angry', '生气': 'angry', '怒': 'angry', '愤怒': 'angry',
    'sad': 'sad', '难过': 'sad', '悲伤': 'sad', '伤心': 'sad', '哭': 'sad',
    'surprise': 'surprise', '惊讶': 'surprise', '吃惊': 'surprise', '震惊': 'surprise',
    'shy': 'shy', '害羞': 'shy', '羞涩': 'shy', '脸红': 'shy',
}
# 已知立绘套装的真实表情清单（与 tsc.js / ai_gen.js 一致）：五套标准 5 表情，mo 额外有 shy
KNOWN_SETS = {
    'su': EMOTIONS, 'shen': EMOTIONS, 'tang': EMOTIONS,
    'mo': EMOTIONS + ('shy',), 'wan': EMOTIONS,
}
ASSET_PREFIX = {'背景': 'bg', '音乐': 'bgm', '音效': 'sfx', '图': 'cg'}
# 预设站位 x 坐标（五位，y 一律 1.0；见 docs/wenyou_design.md 第四节）
POS_X = {'far-left': 0.10, 'left': 0.28, 'center': 0.50, 'right': 0.72, 'far-right': 0.90}
# 景别词 → scale（远 0.75 / 中 0.85 / 近 1.0），中英文皆可
SHOT_SCALE = {'远景': 0.75, 'far': 0.75, '中景': 0.85, 'mid': 0.85, '近景': 1.0, 'close': 1.0}
ASSET_DEFAULT_EXT = {'bg': '.jpg', 'cg': '.jpg', 'bgm': '.mp3', 'sfx': '.wav'}
IMG_AUDIO_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.ogg', '.m4a'}
ID_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


class CompileError(Exception):
    def __init__(self, lineno, msg):
        self.lineno = lineno
        self.msg = msg
        super().__init__(f'第{lineno}行：{msg}')


# ================================================================ 条件表达式解析（校验用，不求值）

class ExprError(Exception):
    pass


def tokenize_expr(src):
    """与引擎 index.html tokenize() 等价的词法：== != >= <= && || > < ! ( )
    字符串/数字/标识符/true/false。"""
    toks, i = [], 0
    while i < len(src):
        c = src[i]
        if c.isspace():
            i += 1
            continue
        two = src[i:i + 2]
        if two in ('==', '!=', '>=', '<=', '&&', '||'):
            toks.append(('op', two)); i += 2; continue
        if c in '><!()':
            toks.append(('op', c)); i += 1; continue
        if c in '"\'':
            j = i + 1
            while j < len(src) and src[j] != c:
                j += 1
            if j >= len(src):
                raise ExprError('字符串未闭合')
            toks.append(('str', src[i + 1:j])); i = j + 1; continue
        m = re.match(r'-?\d+(?:\.\d+)?', src[i:])
        if m:
            toks.append(('num', m.group(0))); i += m.end(); continue
        m = re.match(r'[A-Za-z_][A-Za-z0-9_]*', src[i:])
        if m:
            toks.append(('id', m.group(0))); i += m.end(); continue
        raise ExprError(f'无法解析的字符: {c!r}')
    return toks


def check_expr(src):
    """递归下降校验条件表达式语法（与引擎 parseExpr 同文法），返回引用的变量名集合。
    语法不合法抛 ExprError。"""
    toks = tokenize_expr(src)
    pos = [0]
    varnames = set()

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def eat():
        tk = peek()
        pos[0] += 1
        return tk

    def prim():
        tk = eat()
        if tk is None:
            raise ExprError('表达式意外结束')
        t, v = tk
        if t in ('num', 'str'):
            return
        if t == 'id':
            if v not in ('true', 'false'):
                varnames.add(v)
            return
        if v == '(':
            or_()
            if not peek() or peek()[1] != ')':
                raise ExprError('括号不匹配')
            eat()
            return
        if v == '!':
            prim()
            return
        raise ExprError(f'语法错误：意外的 {v!r}')

    def cmp():
        prim()
        while peek() and peek()[1] in ('==', '!=', '>', '<', '>=', '<='):
            eat()
            prim()

    def and_():
        cmp()
        while peek() and peek()[1] == '&&':
            eat()
            cmp()

    def or_():
        and_()
        while peek() and peek()[1] == '||':
            eat()
            and_()

    if not toks:
        raise ExprError('条件表达式为空')
    or_()
    if pos[0] < len(toks):
        raise ExprError(f'表达式有多余内容: {peek()[1]!r}')
    return varnames


# ================================================================ 解析辅助

def split_args(s, lineno):
    """按空白切分参数，支持 "..." / '...' 引号包裹含空白的值。"""
    out, cur, q = [], '', None
    for ch in s:
        if q:
            if ch == q:
                q = None
            else:
                cur += ch
        elif ch in '"\'':
            q = ch
        elif ch.isspace():
            if cur:
                out.append(cur)
                cur = ''
        else:
            cur += ch
    if q:
        raise CompileError(lineno, '引号未闭合')
    if cur:
        out.append(cur)
    return out


class AssetResolver:
    """裸文件名 → assets 库真实路径。写 背景=town_day 自动解析为 bg/town_day.jpg；
    找不到时告警并按默认扩展名输出（引擎对缺失素材降级占位）。"""

    def __init__(self):
        self.pool = {}   # sub -> {stem或文件名: 文件名}
        for sub in ('bg', 'cg', 'bgm', 'sfx'):
            d = os.path.join(ASSETS_DIR, sub)
            m = {}
            if os.path.isdir(d):
                for f in sorted(os.listdir(d)):
                    if f.endswith('.raw.png') or f.endswith('.chroma.png'):
                        continue
                    if os.path.splitext(f)[1].lower() not in IMG_AUDIO_EXTS:
                        continue
                    m[f] = f
                    m.setdefault(os.path.splitext(f)[0], f)
            self.pool[sub] = m

    def resolve(self, kind, value, lineno, warnings):
        sub = ASSET_PREFIX[kind]
        if value == 'none' and kind == '背景':
            return 'none'
        if '/' in value:                      # 已带目录前缀，原样保留
            fname = value.split('/', 1)[1]
            if fname not in self.pool.get(sub, {}):
                warnings.append(f'第{lineno}行：素材 {value} 在 assets/{sub}/ 中未找到，引擎将降级占位')
            return value
        pool = self.pool.get(sub, {})
        hit = pool.get(value)
        if hit:
            return f'{sub}/{hit}'
        warnings.append(f'第{lineno}行：素材 {sub}/{value} 未找到，按默认扩展名输出，引擎将降级占位')
        return f'{sub}/{value}{ASSET_DEFAULT_EXT[sub]}'


# ================================================================ 编译器主体

class Compiler:
    def __init__(self, text):
        self.lines = text.split('\n')
        self.errors = []
        self.warnings = []
        self.resolver = AssetResolver()
        self.title = None
        self.author = None
        self.characters = {}          # id -> {name, color, prefix, line}
        self.name2id = {}             # 显示名 -> id
        self.attrs = {}               # id -> {name, init, min, max, bar, line}
        self.scenes = []              # 解析中的场景
        self.cur = None               # 当前场景 dict

    # ---------- 错误收集 ----------
    def err(self, lineno, msg):
        self.errors.append(f'第{lineno}行：{msg}')

    # ---------- 主入口 ----------
    def compile(self):
        for n, raw in enumerate(self.lines, 1):
            line = raw.strip()
            if not line or line.startswith('//'):
                continue
            try:
                self.parse_line(n, line)
            except CompileError as e:
                self.errors.append(str(e))
        if self.cur is not None:
            self.flush_choice()
            self.scenes.append(self.cur)
            self.cur = None
        if self.errors:
            self.validate()          # 解析有错仍跑引用校验，一次报全
            return None
        self.validate()
        if self.errors:
            return None
        return self.assemble()

    # ---------- 行分派 ----------
    def parse_line(self, n, line):
        if line.startswith('#'):
            self.parse_meta(n, line)
        elif line.startswith('@角色') and (len(line) == 3 or line[3] in ' \t'):
            if self.scenes or self.cur is not None:
                raise CompileError(n, '@角色 定义必须放在第一个 ==场景 之前（头部）')
            self.parse_char_def(n, line)
        elif line.startswith('%属性'):
            if self.scenes or self.cur is not None:
                raise CompileError(n, '%属性 定义必须放在第一个 ==场景 之前（头部）')
            self.parse_attr_def(n, line)
        elif line.startswith('=='):
            self.parse_scene_head(n, line)
        else:
            if self.cur is None:
                raise CompileError(n, '这行不在任何场景内（场景用 ==场景 开头）')
            self.parse_body(n, line)

    # ---------- 头部 ----------
    def parse_meta(self, n, line):
        toks = split_args(line[1:].strip(), n)
        if len(toks) < 2:
            raise CompileError(n, '头部行格式：# 标题 xxx 或 # 作者 xxx')
        key, val = toks[0], ' '.join(toks[1:])
        if key == '标题':
            self.title = val
        elif key == '作者':
            self.author = val
        else:
            raise CompileError(n, f'未知的头部字段 "{key}"（只支持 标题/作者）')

    def parse_char_def(self, n, line):
        toks = split_args(line[3:].strip(), n)
        if len(toks) < 3:
            raise CompileError(n, '@角色 格式：@角色 <id> <显示名> <颜色> [立绘=<前缀>]')
        cid, name, color = toks[0], toks[1], toks[2]
        if not ID_RE.match(cid):
            raise CompileError(n, f'角色 id "{cid}" 只能含英文字母/数字/下划线')
        if cid in self.characters:
            raise CompileError(n, f'角色 id "{cid}" 重复定义（首次在第{self.characters[cid]["line"]}行）')
        if name in self.name2id:
            raise CompileError(n, f'角色显示名 "{name}" 与角色 {self.name2id[name]} 重复')
        prefix = cid
        for t in toks[3:]:
            if t.startswith('立绘='):
                prefix = t[3:]
            else:
                raise CompileError(n, f'@角色 未知参数 "{t}"（只支持 立绘=<前缀>）')
        if not color.startswith('#'):
            raise CompileError(n, f'颜色 "{color}" 应为 #RRGGBB 形式')
        self.characters[cid] = {'name': name, 'color': color, 'prefix': prefix, 'line': n}
        self.name2id[name] = cid

    def parse_attr_def(self, n, line):
        toks = split_args(line[3:].strip(), n)
        if len(toks) < 6:
            raise CompileError(n, '%属性 格式：%属性 <id> <显示名> <初值> <最小> <最大> <颜色> [@归属]')
        aid, name = toks[0], toks[1]
        if not ID_RE.match(aid):
            raise CompileError(n, f'属性 id "{aid}" 只能含英文字母/数字/下划线')
        if aid in self.attrs:
            raise CompileError(n, f'属性 id "{aid}" 重复定义（首次在第{self.attrs[aid]["line"]}行）')
        try:
            init, lo, hi = float(toks[2]), float(toks[3]), float(toks[4])
        except ValueError:
            raise CompileError(n, f'%属性 的 初值/最小/最大 必须是数字：{toks[2]} {toks[3]} {toks[4]}')
        color = toks[5]
        owner_raw = None
        for t in toks[6:]:
            if t.startswith('@') and owner_raw is None:
                owner_raw = t[1:]
                if not owner_raw:
                    raise CompileError(n, '%属性 归属 @ 后缺少 主控/player/我/角色id')
            else:
                raise CompileError(n, f'%属性 未知参数 "{t}"（归属写法：@主控 / @player / @我 / @角色id）')
        self.attrs[aid] = {'name': name, 'init': init, 'min': lo, 'max': hi,
                           'bar': color, 'owner_raw': owner_raw, 'line': n}

    # ---------- 场景头 ----------
    def parse_scene_head(self, n, line):
        toks = split_args(line[2:].strip(), n)
        if toks and toks[0] == '场景':
            toks = toks[1:]
        if not toks:
            raise CompileError(n, '==场景 缺少场景 id')
        sid = toks[0]
        if not ID_RE.match(sid):
            raise CompileError(n, f'场景 id "{sid}" 只能含英文字母/数字/下划线')
        for sc in self.scenes:
            if sc['id'] == sid:
                raise CompileError(n, f'场景 id "{sid}" 重复定义（首次在第{sc["_line"]}行）')
        scene = {'id': sid, 'script': [], '_line': n}
        for t in toks[1:]:
            if t == '存档点':
                scene['checkpoint'] = True
                continue
            if '=' not in t:
                raise CompileError(n, f'场景参数 "{t}" 无法识别（支持 背景=/音乐=/音效=/存档点/进入条件=/条件跳转=）')
            key, val = t.split('=', 1)
            if key == '背景':
                scene['background'] = self.resolver.resolve('背景', val, n, self.warnings)
            elif key == '音乐':
                scene['bgm'] = self.resolver.resolve('音乐', val, n, self.warnings)
            elif key == '音效':
                items = [self.resolver.resolve('音效', v, n, self.warnings)
                         for v in val.split(',') if v]
                if not items:
                    raise CompileError(n, '音效= 后至少给一个音效文件')
                scene['sfx'] = items[0] if len(items) == 1 else items
            elif key == '进入条件':
                self.guard_expr(n, val)
                scene['require'] = val
            elif key == '条件跳转':
                scene['require_else'] = val
                scene['_require_else_line'] = n
            else:
                raise CompileError(n, f'未知场景参数 "{key}="')
        if 'require_else' in scene and 'require' not in scene:
            raise CompileError(n, '条件跳转 必须与 进入条件 一起使用')
        if self.cur is not None:
            self.flush_choice()
            self.scenes.append(self.cur)
        self.cur = scene

    # ---------- 场景体 ----------
    def parse_body(self, n, line):
        if line.startswith('?'):
            self.flush_choice()
            self.cur['_pending_choice'] = {'type': 'choice', 'options': [], '_line': n}
            return
        if line.startswith('>'):
            ch = self.cur.get('_pending_choice')
            if ch is None:
                raise CompileError(n, '选项行 > 必须跟在 ? 行之后')
            ch['options'].append(self.parse_option(n, line[1:].strip()))
            return
        self.flush_choice()
        if line.startswith('@'):
            self.parse_station(n, line)
        elif line.startswith('!set'):
            self.cur['script'].append({'type': 'set',
                                       'vars': self.parse_set_ops(n, line[4:].strip()),
                                       '_line': n})
        elif line.startswith('!show'):
            rest = line[5:].strip()
            if not rest:
                raise CompileError(n, '!show 缺少 CG 文件名')
            self.cur['script'].append({'type': 'show',
                                       'image': self.resolver.resolve('图', rest, n, self.warnings),
                                       '_line': n})
        elif line.startswith('!调查'):
            self.parse_inspect(n, line[3:].strip())
        elif line.startswith('!判定'):
            self.parse_check(n, line[3:].strip())
        elif line.startswith('->'):
            self.parse_goto(n, line[2:].strip())
        elif line.startswith('::结局'):
            label = line[4:].strip()
            if not label:
                raise CompileError(n, '::结局 缺少结局名')
            self.cur['script'].append({'type': 'end', 'label': label, '_line': n})
        else:
            self.parse_text(n, line)

    def flush_choice(self):
        ch = self.cur.pop('_pending_choice', None)
        if ch is not None:
            if not ch['options']:
                self.err(ch['_line'], '? 选项块至少需要一个 > 选项')
            self.cur['script'].append(ch)

    # ---------- 选项 ----------
    def parse_option(self, n, s):
        opt = {'_line': n}
        # 1) 尾部 -> 目标
        if '->' in s:
            s, _, target = s.rpartition('->')
            target = target.strip()
            if not target:
                raise CompileError(n, '-> 后缺少目标场景 id')
            opt['goto'] = target
            s = s.strip()
        # 2) {变量操作}
        m = re.search(r'\{([^{}]*)\}', s)
        if m:
            ops = self.try_set_ops(m.group(1))
            if ops is None:
                raise CompileError(n, f'选项的 {{...}} 变量操作无法解析：{{{m.group(1)}}}'
                                      '（{{变量}} 插值只用于对白/旁白文本，选项里 {{}} 是变量操作）')
            opt['set'] = ops
            s = (s[:m.start()] + s[m.end():]).strip()
        # 3) [条件]
        m = re.search(r'\[([^\[\]]*)\]', s)
        if m:
            cond = m.group(1).strip()
            self.guard_expr(n, cond, context='选项条件')
            opt['if'] = cond
            opt['_cond_vars'] = sorted(self.expr_vars(cond))
            s = (s[:m.start()] + s[m.end():]).strip()
        if not s:
            raise CompileError(n, '选项缺少文本')
        opt['text'] = s
        return opt

    # ---------- 站位 ----------
    def parse_station(self, n, line):
        toks = split_args(line[1:].strip(), n)
        if not toks:
            raise CompileError(n, '@ 站位行缺少角色 id')
        cid = toks[0]
        if cid == '角色':
            raise CompileError(n, '@角色 定义必须放在头部（第一个 ==场景 之前）')
        if cid not in self.characters:
            raise CompileError(n, f'未定义的角色 "{cid}"（请先在头部用 @角色 定义）')
        entry = {'id': cid, '_line': n}
        pos_tok = None      # 预设位：far-left/left/center/right/far-right
        free_pos = None     # 自由位 x,y,scale
        shot_scale = None   # 景别词 / 裸数字缩放
        for t in toks[1:]:
            emo = EMO_ALIAS.get(t)
            if emo:
                entry['sprite'] = emo
            elif t in POS_X:
                pos_tok = t
            elif t in SHOT_SCALE:
                shot_scale = SHOT_SCALE[t]
            elif re.match(r'^\d*\.?\d+(\s*,\s*\d*\.?\d+){2}$', t):
                x, y, scale = [float(v) for v in t.split(',')]
                free_pos = {'x': x, 'y': y, 'scale': scale}
            elif re.match(r'^\d*\.?\d+$', t):
                shot_scale = float(t)
            else:
                raise CompileError(n, f'站位参数 "{t}" 无法识别'
                                      '（表情/far-left/left/center/right/far-right/远景/中景/近景/far/mid/close/数字缩放/x,y,scale）')
        if free_pos and shot_scale is not None:
            raise CompileError(n, '自由位 x,y,scale 已含缩放，不能再加景别词')
        if free_pos:
            entry.update(free_pos)
        elif pos_tok in ('far-left', 'far-right') or shot_scale is not None:
            # far-left/far-right 或带景别词：一律转自由位（三槽 pos 没有 scale）
            entry.update({'x': POS_X[pos_tok or 'center'], 'y': 1.0,
                          'scale': shot_scale if shot_scale is not None else 0.85})
        else:
            entry['pos'] = pos_tok or 'center'
        self.cur.setdefault('chars', []).append(entry)

    # ---------- set 变量操作 ----------
    def try_set_ops(self, s):
        """解析 'favor+5 gold=100 flag=1' → {'favor':'favor+5','gold':100,'flag':1}。
        无法解析返回 None。"""
        s = s.replace('，', ',')
        toks = [t for t in re.split(r'[\s,]+', s.strip()) if t]
        if not toks:
            return None
        out = {}
        for t in toks:
            m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)([+-])(\d+(?:\.\d+)?)$', t)
            if m:
                out[m.group(1)] = f'{m.group(1)}{m.group(2)}{m.group(3)}'
                continue
            m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.+)$', t)
            if m:
                var, val = m.group(1), m.group(2)
                if re.match(r'^-?\d+(\.\d+)?$', val):
                    out[var] = float(val) if '.' in val else int(val)
                elif val in ('true', 'false'):
                    out[var] = (val == 'true')
                else:
                    try:
                        check_expr(val)          # 表达式赋值：原样交给引擎求值
                    except ExprError:
                        return None
                    out[var] = val
                continue
            return None
        return out

    def parse_set_ops(self, n, s):
        ops = self.try_set_ops(s)
        if ops is None:
            raise CompileError(n, f'变量操作无法解析：{s!r}（支持 favor+5 / gold=100 / flag=1）')
        return ops

    # ---------- 调查 ----------
    def parse_inspect(self, n, s):
        m = re.match(r'^(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*(.*)$', s)
        if not m:
            raise CompileError(n, '!调查 格式：!调查 x,y,w,h 图=xxx 文=xxx（x,y,w,h 为 0-1 视口比例）')
        x, y, w, h = (float(m.group(i)) for i in range(1, 5))
        rest = m.group(5).strip()
        cmd = {'type': 'inspect', 'x': x, 'y': y, 'w': w, 'h': h, '_line': n}
        show = {}
        mt = re.search(r'文=(.*)$', rest)
        if mt:
            show['text'] = mt.group(1).strip()
            rest = rest[:mt.start()].strip()
        mi = re.search(r'图=(\S+)', rest)
        if mi:
            show['image'] = self.resolver.resolve('图', mi.group(1), n, self.warnings)
            rest = (rest[:mi.start()] + rest[mi.end():]).strip()
        if rest:
            raise CompileError(n, f'!调查 无法识别的参数：{rest!r}')
        if show:
            cmd['show'] = show
        self.cur['script'].append(cmd)

    # ---------- 判定 ----------
    @staticmethod
    def _num(v):
        """'15' -> 15（int），'15.5' -> 15.5（float），与 tsc.js 输出保持一致。"""
        f = float(v)
        return int(f) if f == int(f) else f

    def resolve_attr(self, n, token):
        """判定属性：可写 id 或显示名（同对白说话人规则）。未定义仅告警（运行时按 0）。"""
        if token in self.attrs:
            return token
        for aid, a in self.attrs.items():
            if a['name'] == token:
                return aid
        self.warnings.append(
            f'第{n}行：!判定 引用的属性 "{token}" 未在 %属性 中定义（运行时按 0 处理）')
        return token

    def attr_display(self, aid):
        a = self.attrs.get(aid)
        return a['name'] if a else aid

    def parse_check(self, n, s):
        """!判定 属性>=值 [成功->场景 {set}] [失败->场景 {set}] [行尾条件]
        !判定 属性 难度N 掷骰 [成功/失败同上]   —— "掷骰" 关键词切换 roll 模式"""
        # 1) 行尾 [条件] → if（与其它指令一致）
        cond = None
        m = re.search(r'\[([^\[\]]*)\]\s*$', s)
        if m:
            cond = m.group(1).strip()
            self.guard_expr(n, cond)
            s = s[:m.start()].strip()
        # 2) 成功/失败 分段
        parts = re.split(r'(成功|失败)', s)
        head = parts[0].strip()
        branches = {}
        for i in range(1, len(parts), 2):
            branches[parts[i]] = parts[i + 1]
        # 3) 头部：judge = 属性op值；roll = 属性 难度N 掷骰
        attr = op = value = None
        if '掷骰' in head:
            mode = 'roll'
            head = head.replace('掷骰', ' ').strip()
            md = re.search(r'难度\s*(-?\d+(?:\.\d+)?)', head)
            if not md:
                raise CompileError(n, '!判定 掷骰模式需要写 难度N（如：!判定 魅力 难度18 掷骰 成功->s_a 失败->s_b）')
            value = self._num(md.group(1))
            attr = (head[:md.start()] + head[md.end():]).strip()
            if not attr:
                raise CompileError(n, '!判定 缺少判定属性（如：!判定 魅力 难度18 掷骰 …）')
        else:
            if '难度' in head:
                raise CompileError(n, '难度N 只用于掷骰模式：!判定 属性 难度N 掷骰 …')
            mj = re.match(r'^([^\s=<>!]+?)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$', head)
            if not mj:
                raise CompileError(n, '!判定 格式：!判定 属性>=值 [成功->场景 {set}] [失败->场景 {set}]'
                                      '；掷骰：!判定 属性 难度N 掷骰 …')
            mode = 'judge'
            attr, op, value = mj.group(1), mj.group(2), self._num(mj.group(3))
        attr = self.resolve_attr(n, attr)
        # 4) 分支
        success = self.parse_check_branch(n, '成功', branches['成功']) if '成功' in branches else None
        fail = self.parse_check_branch(n, '失败', branches['失败']) if '失败' in branches else None
        # 5) 按固定字段顺序组装（与 tsc.js 一致）
        cmd = {'type': 'check', 'attr': attr}
        if op is not None:
            cmd['op'] = op
        cmd['value'] = value
        cmd['mode'] = mode
        cmd['text'] = self.attr_display(attr) + '判定'
        if success:
            cmd['success'] = success
        if fail:
            cmd['fail'] = fail
        if cond is not None:
            cmd['if'] = cond
        cmd['_line'] = n
        self.cur['script'].append(cmd)

    def parse_check_branch(self, n, key, body):
        """解析 成功/失败 后的内容：->场景 与 {变量操作}，任意顺序，可都省（=顺序继续）。"""
        out = {}
        rest = body
        mg = re.search(r'->\s*([A-Za-z_][A-Za-z0-9_]*)', rest)
        if mg:
            out['goto'] = mg.group(1)
            rest = rest[:mg.start()] + rest[mg.end():]
        ms = re.search(r'\{([^{}]*)\}', rest)
        if ms:
            ops = self.try_set_ops(ms.group(1))
            if ops is None:
                raise CompileError(n, f'!判定 {key} 的 {{...}} 变量操作无法解析：{{{ms.group(1)}}}')
            out['set'] = ops
            rest = rest[:ms.start()] + rest[ms.end():]
        if rest.strip():
            raise CompileError(n, f'!判定 {key} 后无法识别的内容：{rest.strip()!r}'
                                  '（支持 ->场景 与 {变量操作}）')
        return out

    # ---------- 跳转 ----------
    def parse_goto(self, n, s):
        m = re.match(r'^(\S+)(?:\s*\[([^\[\]]*)\])?\s*$', s)
        if not m:
            raise CompileError(n, '-> 跳转格式：-> 场景id [条件]')
        target, cond = m.group(1), m.group(2)
        cmd = {'type': 'goto', 'target': target, '_line': n}
        if cond is not None:
            cond = cond.strip()
            self.guard_expr(n, cond)
            cmd['if'] = cond
        self.cur['script'].append(cmd)

    # ---------- 旁白 / 对白 ----------
    def parse_text(self, n, line):
        cond = None
        m = re.search(r'\[([^\[\]]*)\]\s*$', line)
        if m:
            cond = m.group(1).strip()
            self.guard_expr(n, cond)
            line = line[:m.start()].strip()
        m = re.match(r'^([^:：]{1,20}?)(?:[（(]([^）)]*)[）)])?[:：](.*)$', line)
        if m and m.group(3).strip():
            speaker, emo, text = m.group(1).strip(), m.group(2), m.group(3).strip()
            cid = speaker if speaker in self.characters else self.name2id.get(speaker)
            if cid is not None:
                cmd = {'type': 'say', 'who': cid, 'text': text, '_line': n}
                if emo:
                    e = EMO_ALIAS.get(emo.strip())
                    if not e:
                        raise CompileError(n, f'未知表情 "{emo}"（支持 {"、".join(EMOTIONS)}、shy 及中文别名）')
                    cmd['sprite'] = e  # 引擎 say 不读 sprite，仅供可读性；表情通过站位体现
                    cmd.pop('sprite')
                if cond is not None:
                    cmd['if'] = cond
                self.cur['script'].append(cmd)
                return
            if emo is not None:
                raise CompileError(n, f'未定义的角色 "{speaker}"（请先在头部用 @角色 定义）')
            # 无括号且不是角色名：按含冒号的旁白处理
        if not line:
            raise CompileError(n, '空文本行')
        cmd = {'type': 'narrate', 'text': line, '_line': n}
        if cond is not None:
            cmd['if'] = cond
        self.cur['script'].append(cmd)

    # ---------- 表达式守卫 ----------
    def guard_expr(self, n, src, context='条件表达式'):
        try:
            check_expr(src)
        except ExprError as e:
            raise CompileError(n, f'{context}语法错误：{src!r}（{e}）')

    def expr_vars(self, src):
        try:
            return check_expr(src)
        except ExprError:
            return set()

    # ---------- 全局校验 ----------
    def validate(self):
        if not self.title:
            self.errors.append('缺少标题：请在头部写 # 标题 xxx')
        if not self.scenes:
            self.errors.append('剧本没有任何场景（==场景 开头）')
            return
        ids = {sc['id'] for sc in self.scenes}

        # 0) 属性归属解析：@主控/@player/@我 → player；@角色id → 该角色（须已定义）
        for aid, a in self.attrs.items():
            raw = a.get('owner_raw')
            if raw is None:
                continue
            if raw in ('主控', 'player', '我'):
                a['owner'] = 'player'
            elif raw in self.characters:
                a['owner'] = raw
            else:
                self.err(a['line'], f'属性 "{aid}" 的归属 "@{raw}" 不是已定义的角色 id'
                                    '（主控写法：@主控 / @player / @我）')

        # 1) 场景引用
        for sc in self.scenes:
            ref = sc.get('require_else')
            if ref and ref not in ids:
                self.err(sc['_require_else_line'],
                         f'条件跳转 指向未定义的场景 "{ref}"')
            for cmd in sc['script']:
                if cmd['type'] == 'goto' and cmd['target'] not in ids:
                    self.err(cmd['_line'], f'-> 跳转指向未定义的场景 "{cmd["target"]}"')
                if cmd['type'] == 'choice':
                    for o in cmd['options']:
                        if 'goto' in o and o['goto'] not in ids:
                            self.err(o['_line'], f'选项 -> 指向未定义的场景 "{o["goto"]}"')
                if cmd['type'] == 'check':
                    for bk, bname in (('success', '成功'), ('fail', '失败')):
                        br = cmd.get(bk) or {}
                        if br.get('goto') and br['goto'] not in ids:
                            self.err(cmd['_line'],
                                     f'!判定 {bname} 指向未定义的场景 "{br["goto"]}"')
        if not self.errors:
            # 2) 场景收尾：执行不能跑出场景末尾（否则游戏卡死）
            for sc in self.scenes:
                if not sc['script']:
                    self.err(sc['_line'], f'场景 "{sc["id"]}" 内容为空')
                    continue
                safe = False
                for cmd in reversed(sc['script']):
                    t = cmd['type']
                    if t == 'end':
                        safe = True
                    elif t == 'goto':
                        if 'if' not in cmd:
                            safe = True
                    elif t == 'choice':
                        if cmd['options'] and all('goto' in o for o in cmd['options']):
                            safe = True
                    elif t == 'check':
                        # 成功/失败都带跳转且指令本身无条件：两条路都离场，不会跑出末尾
                        if 'if' not in cmd \
                                and (cmd.get('success') or {}).get('goto') \
                                and (cmd.get('fail') or {}).get('goto'):
                            safe = True
                if not safe:
                    self.err(sc['_line'],
                             f'场景 "{sc["id"]}" 可能执行到末尾后卡死：请以 -> 跳转、'
                             '::结局 或「所有选项都带 ->」的选项块收尾')

        if not self.errors:
            # 3) 结局可达性：从第一个场景出发 BFS
            adj = {sc['id']: set() for sc in self.scenes}
            for i, sc in enumerate(self.scenes):
                if sc.get('require_else'):
                    adj[sc['id']].add(sc['require_else'])
                elif sc.get('require') and i + 1 < len(self.scenes):
                    adj[sc['id']].add(self.scenes[i + 1]['id'])   # require 失败且无 else 时顺延
                for cmd in sc['script']:
                    if cmd['type'] == 'goto':
                        adj[sc['id']].add(cmd['target'])
                    elif cmd['type'] == 'choice':
                        for o in cmd['options']:
                            if 'goto' in o:
                                adj[sc['id']].add(o['goto'])
                    elif cmd['type'] == 'check':
                        for bk in ('success', 'fail'):
                            g = (cmd.get(bk) or {}).get('goto')
                            if g:
                                adj[sc['id']].add(g)
            seen, stack = set(), [self.scenes[0]['id']]
            while stack:
                cur = stack.pop()
                if cur in seen:
                    continue
                seen.add(cur)
                stack.extend(adj.get(cur, ()) - seen)
            ends = [cmd['label'] for sc in self.scenes if sc['id'] in seen
                    for cmd in sc['script'] if cmd['type'] == 'end']
            if not ends:
                self.errors.append('结局可达性校验失败：从第一个场景出发走不到任何 ::结局')
            unreachable = [sc['id'] for sc in self.scenes if sc['id'] not in seen]
            for sid in unreachable:
                self.warnings.append(f'场景 "{sid}" 从入口不可达（死场景）')

        # 4) 选项条件变量告警（未在 %属性 定义）
        for sc in self.scenes:
            for cmd in sc['script']:
                if cmd['type'] != 'choice':
                    continue
                for o in cmd['options']:
                    for v in o.get('_cond_vars', []):
                        if v not in self.attrs:
                            self.warnings.append(
                                f'第{o["_line"]}行：选项条件引用的变量 "{v}" 未在 %属性 中定义'
                                '（运行时按 0 处理）')

        # 5) 定义未使用告警
        used_chars = set()
        for sc in self.scenes:
            for c in sc.get('chars', []):
                used_chars.add(c['id'])
            for cmd in sc['script']:
                if cmd['type'] == 'say':
                    used_chars.add(cmd['who'])
        for cid, c in self.characters.items():
            if cid not in used_chars:
                self.warnings.append(f'第{c["line"]}行：角色 "{cid}"（{c["name"]}）定义后从未出场')
        used_vars = set()
        for sc in self.scenes:
            for cmd in sc['script']:
                if cmd['type'] == 'set':
                    used_vars.update(cmd['vars'])
                elif cmd['type'] == 'choice':
                    for o in cmd['options']:
                        used_vars.update((o.get('set') or {}).keys())
                elif cmd['type'] == 'check':
                    for bk in ('success', 'fail'):
                        used_vars.update(((cmd.get(bk) or {}).get('set') or {}).keys())
        for aid, a in self.attrs.items():
            if aid not in used_vars:
                self.warnings.append(f'第{a["line"]}行：属性 "{aid}"（{a["name"]}）从未被修改')

    # ---------- 输出 ----------
    def assemble(self):
        def num(v):
            return int(v) if float(v) == int(v) else v

        attrs = {}
        for aid, a in self.attrs.items():
            item = {'name': a['name'], 'init': num(a['init']),
                    'min': num(a['min']), 'max': num(a['max']), 'bar': a['bar']}
            if a.get('owner'):
                item['owner'] = a['owner']    # 归属：player 或角色 id（仅影响面板分组）
            attrs[aid] = item
        chars = {}
        for cid, c in self.characters.items():
            if c['prefix'] in KNOWN_SETS:
                # 已知套装：只生成真实存在的表情键（缺表情时引擎回退 normal，不会破图）
                emos = KNOWN_SETS[c['prefix']]
            else:
                # 自定义前缀：标准 5 表情 + 站位里实际用到的额外表情（如 shy），与 tsc.js 一致
                emos = list(EMOTIONS)
                for sc in self.scenes:
                    for ch in sc.get('chars', []):
                        if ch['id'] == cid and ch.get('sprite') and ch['sprite'] not in emos:
                            emos.append(ch['sprite'])
            chars[cid] = {'name': c['name'], 'color': c['color'],
                          'sprites': {e: f'chars/{c["prefix"]}_{e}.png' for e in emos}}
        scenes = []
        for sc in self.scenes:
            out = {k: v for k, v in sc.items() if not k.startswith('_')}
            out['chars'] = [{k: v for k, v in c.items() if not k.startswith('_')}
                            for c in sc.get('chars', [])]
            if not out['chars']:
                out.pop('chars')
            script = []
            for cmd in sc['script']:
                c = {k: v for k, v in cmd.items() if not k.startswith('_')}
                if c['type'] == 'choice':
                    c['options'] = [{k: v for k, v in o.items() if not k.startswith('_')}
                                    for o in c['options']]
                script.append(c)
            out['script'] = script
            scenes.append(out)
        meta = {'title': self.title, 'author': self.author or '', 'version': '1.0',
                'defaults': {'text_speed': 25, 'bgm_volume': 0.5, 'auto_delay': 1800}}
        return {'meta': meta, 'attrs': attrs, 'characters': chars,
                'assets_dir': 'assets/', 'scenes': scenes}


# ================================================================ 内置示例（--demo）

DEMO_SRC = '''// 灯下问仙 · 文字脚本示例（python tools/tsc.py --demo）
# 标题 灯下问仙
# 作者 文游工坊

@角色 su 苏璃 #FFB6C1 立绘=su
@角色 shen 沈青 #87CEEB 立绘=shen
@角色 tang 阿棠 #E8C47E 立绘=tang

%属性 favor 苏璃好感 0 0 100 #FFB6C1
%属性 xiuwei 修为 0 0 100 #87CEEB

==场景 s1_town 背景=town_day 音乐=town_day 音效=wind_chime 存档点
@su normal center
你回到灯溪镇的那天，风里都是灯油的味道。
苏璃(微笑): 阿灯！三年不见，你回来啦！
苏璃(惊讶): 你怀里……还揣着那只没做完的兔子灯？
?
> 陪她放灯 {favor+6} -> s2_lantern
> 去竹林闭关 {xiuwei+15} -> s2_bamboo
> 直接闯山门 [xiuwei>=20] -> s3_test

==场景 s2_lantern 背景=lantern_shop 音乐=shop_warm
@su smile left
灯笼铺里，苏璃把竹骨一根根剖开。
苏璃(微笑): 帮我拉住灯口，别动。
!调查 0.42,0.62,0.16,0.18 图=teacup 文=粗陶茶盏，盏底有一道旧磕痕。
?
> 买下那只兔子灯送她 [favor>=5] {favor+6} -> s3_test
> 默默离开 -> s3_test

==场景 s2_bamboo 背景=bamboo 音乐=bamboo_wind 音效=bamboo_rustle
@shen normal right
竹林深处，沈青收剑而立。
沈青: 闭关三日，可有长进？
!show sword_light
?
> 与沈青切磋 [xiuwei>=10] {xiuwei+10} -> s3_test
> 下山赴试 -> s3_test

==场景 s3_test 背景=bamboo_night 音乐=tense 存档点 进入条件="xiuwei>=20 || favor>=10" 条件跳转=s3_fallback
山门试炼，一剑问心。
你的修为是{xiuwei}，苏璃对你的好感是{favor}。
?
> 与苏璃归隐灯下 [favor>=12] -> s_end_love
> 拜入山门 -> s_end_join

==场景 s3_fallback 背景=teashelter_night 音乐=teashelter
@tang normal center
试炼落第。山脚下的茶棚还亮着灯。
阿棠(微笑): 客官，进来喝杯热茶吧。
::结局 归隐茶棚

==场景 s_end_love 背景=festival_night 音乐=festival
@su smile center
上元灯火如昼，兔子灯终于做完了。
苏璃(微笑): 这一次，不许再走啦。
::结局 灯火良缘

==场景 s_end_join 背景=bridge_sunset
山门晨钟暮鼓，从此青灯相伴。
::结局 青灯问道
'''


# ================================================================ CLI

def run_compile(src_path, text):
    comp = Compiler(text)
    script = comp.compile()
    for w in comp.warnings:
        print(f'[告警] {w}')
    if script is None:
        for e in comp.errors:
            print(f'[错误] {e}', file=sys.stderr)
        print(f'[失败] {src_path}：{len(comp.errors)} 个错误，编译中止', file=sys.stderr)
        return None, comp
    return script, comp


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')   # Windows 控制台默认 GBK
        except Exception:
            pass
    ap = argparse.ArgumentParser(description='文游·文字脚本编译器：.txt → 剧本 JSON')
    ap.add_argument('script', nargs='?', help='文字脚本 .txt 路径')
    ap.add_argument('-o', '--out', help='输出 JSON 路径（默认与输入同名 .json）')
    ap.add_argument('--check', action='store_true', help='只校验，不写盘')
    ap.add_argument('--demo', action='store_true', help='打印内置示例文本脚本')
    args = ap.parse_args()

    if args.demo:
        try:
            sys.stdout.reconfigure(encoding='utf-8')   # Windows 控制台默认 GBK，重定向会丢字
        except Exception:
            pass
        sys.stdout.write(DEMO_SRC)
        return

    if not args.script:
        ap.error('必须提供文字脚本路径（或用 --demo）')
    with open(args.script, encoding='utf-8-sig') as f:
        text = f.read()

    script, comp = run_compile(args.script, text)
    if script is None:
        sys.exit(1)
    if args.check:
        print(f'[完成] 校验通过：{len(script["scenes"])} 个场景，'
              f'{sum(1 for sc in script["scenes"] for c in sc["script"] if c["type"] == "end")} 个结局')
        return

    out = args.out or os.path.splitext(args.script)[0] + '.json'
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(script, f, ensure_ascii=False, indent=2)
    n_end = sum(1 for sc in script['scenes'] for c in sc['script'] if c['type'] == 'end')
    print(f'[完成] 编译成功：{len(script["scenes"])} 个场景，{n_end} 个结局 → {out}')


if __name__ == '__main__':
    main()
