#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地一键自主小说管线 (workflow C1)

一条命令从题材到可发布游戏：
  ① 复用 wenyou/script_gen.py 生成剧本 JSON（API key 来源与其一致：
     STEP_API_KEY 环境变量或 E:/user/content_factory/secrets/step_api_key.txt）
  ② 素材策略：
     --reuse-assets（默认）从 demo_gl/assets 现有背景/立绘库按氛围关键词
       智能匹配，把剧本里的资源路径重写到现有文件，零成本即时可玩；
     --gen-assets 调 wenyou/assets_gen.py 按剧本出新图（需 API，花钱）
  ③ 校验剧本（角色引用 / 悬空 goto / 可达性，复用 script_gen 的校验函数）
  ④ 以 demo_gl/index.html 为模板替换 EMBEDDED_SCRIPT 生成新游戏变体到
     games_output/<题材>/，并自动跑 build.py 等效转换（图片转 WebP、
     引用改 .webp）。严禁修改 index.html 本体，此处只读不写。

用法（从 demo_gl 运行）：
  python tools/autonovel.py "修仙山门悬案"
  python tools/autonovel.py "修仙山门悬案" --chars "苏璃:活泼师妹;陈默:沉稳师兄" --scenes 5
  python tools/autonovel.py "修仙山门悬案" --gen-assets     # 出新图（调 API）
  python tools/autonovel.py "修仙山门悬案" --dry-run        # 预览，不调 API 不写盘
  python tools/autonovel.py --self-test                     # 内置假剧本自测
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_ROOT = os.path.dirname(TOOLS_DIR)            # demo_gl/
REPO_ROOT = os.path.dirname(DEMO_ROOT)            # wenyou/
SCRIPT_GEN = os.path.join(REPO_ROOT, 'script_gen.py')
ASSETS_GEN = os.path.join(REPO_ROOT, 'assets_gen.py')
SRC_ASSETS = os.path.join(DEMO_ROOT, 'assets')
TEMPLATE_HTML = os.path.join(DEMO_ROOT, 'index.html')
OUT_ROOT = os.path.join(DEMO_ROOT, 'games_output')

# 与 tools/build.py 保持一致：子目录 -> (最长边, WebP 质量)
IMG_RULES = {'bg': (1920, 80), 'cg': (1920, 85), 'chars': (1024, 85)}
IMG_EXTS = ('.png', '.jpg', '.jpeg')
AUDIO_EXTS = ('.mp3', '.wav', '.ogg', '.m4a')

# 中文氛围词 -> 英文文件名 token（用于把 LLM 编的背景名匹配到现有素材库）
MOOD_TOKENS = {
    '雨': ['rain', 'rainy'], '夜': ['night'], '晚': ['night', 'evening'],
    '竹': ['bamboo'], '桥': ['bridge'], '夕阳': ['sunset'], '黄昏': ['dusk', 'sunset'],
    '咖啡': ['cafe'], '午后': ['afternoon'], '城': ['city'], '灯火': ['lights', 'lantern'],
    '渡': ['ferry'], '船': ['ferry'], '河': ['ferry'], '江': ['ferry'],
    '灯': ['lantern', 'festival'], '节': ['festival'], '铺': ['shop'], '店': ['shop'],
    '衙': ['law', 'office'], '公堂': ['law'], '府': ['law', 'office'], '法': ['law'],
    '酒楼': ['restaurant'], '餐': ['restaurant'], '饭': ['restaurant'],
    '街': ['street'], '市': ['street', 'town'], '车': ['taxi'],
    '茶': ['tea', 'teashelter'], '镇': ['town'], '日': ['day'],
    '山': ['town', 'bamboo'], '林': ['bamboo'], '剑': ['sword'], '刀': ['sword'],
    '杯': ['teacup'], '盏': ['teacup'], '碗': ['teacup'], '光': ['light'],
    '斗': ['sword', 'light'], '战': ['sword', 'light'],
}

# ---------------------------------------------------------------- 内置假剧本（--self-test / --dry-run 用，不调 API）

def fake_script():
    """内置假剧本：2 角色 4 场景，含 choice 分支 / show / inspect / 双结局。"""
    sprites = lambda cid: {e: f"chars/{cid}_{e}.png"
                           for e in ("normal", "smile", "angry", "sad", "surprise")}
    return {
        "meta": {"title": "自测·山门悬案", "author": "autonovel 自测", "version": "1.0",
                 "defaults": {"text_speed": 25, "bgm_volume": 0.5, "auto_delay": 1800}},
        "characters": {
            "c1": {"name": "苏璃", "color": "#FFB6C1", "sprites": sprites("c1")},
            "c2": {"name": "陈默", "color": "#87CEEB", "sprites": sprites("c2")},
        },
        "assets_dir": "assets/",
        "scenes": [
            {"id": "s1_gate", "background": "bg/mountain_gate_rainy_night.jpg",
             "bgm": "bgm/rain_night.mp3", "sfx": ["sfx/thunder.wav"],
             "checkpoint": True,
             "chars": [{"id": "c1", "pos": "left", "sprite": "normal", "effect": "fade"}],
             "script": [
                 {"type": "narrate", "text": "雨夜，山门前的石阶上躺着一具无名尸。"},
                 {"type": "say", "who": "c1", "text": "师兄，你看他手里攥着的东西……"},
                 {"type": "inspect", "x": 0.4, "y": 0.6, "w": 0.2, "h": 0.2,
                  "show": {"image": "cg/teacup_clue.png", "text": "半只碎茶盏，盏底刻着竹林纹样。"}},
                 {"type": "choice", "options": [
                     {"text": "去竹林查茶盏来历", "goto": "s2_bamboo", "set": {"flag_cup": 1}},
                     {"text": "先回议事厅禀报掌门", "goto": "s2_hall"}]}]},
            {"id": "s2_bamboo", "background": "bg/bamboo_forest.jpg",
             "chars": [{"id": "c2", "pos": "right", "sprite": "sad", "effect": "fade"}],
             "script": [
                 {"type": "say", "who": "c2", "text": "这纹样……是后山竹棚的茶盏。"},
                 {"type": "show", "image": "cg/sword_light_clash.jpg"},
                 {"type": "goto", "target": "s3_truth"}]},
            {"id": "s2_hall", "background": "bg/great_hall_dusk.jpg",
             "chars": [{"id": "c1", "pos": "left", "sprite": "angry", "effect": "fade"}],
             "script": [
                 {"type": "say", "who": "c1", "text": "掌门，死者身份恐怕不简单。"},
                 {"type": "goto", "target": "s3_truth"}]},
            {"id": "s3_truth", "background": "bg/hall_night.jpg", "checkpoint": True,
             "chars": [{"id": "c1", "pos": "left", "sprite": "normal", "effect": "fade"},
                       {"id": "c2", "pos": "right", "sprite": "surprise", "effect": "fade"}],
             "script": [
                 {"type": "narrate", "text": "真相大白：凶手竟是扫地多年的老杂役。"},
                 {"type": "choice", "options": [
                     {"text": "饶他一命", "goto": "s_end_mercy", "if": "flag_cup==1"},
                     {"text": "交由门规处置", "goto": "s_end_law"}]}]},
            {"id": "s_end_mercy",
             "script": [{"type": "narrate", "text": "你放他下山。雨停了。"},
                        {"type": "end", "label": "结局·慈悲"}]},
            {"id": "s_end_law",
             "script": [{"type": "narrate", "text": "门规如山，谁也无话可说。"},
                        {"type": "end", "label": "结局·铁律"}]},
        ],
    }


# ---------------------------------------------------------------- 素材库扫描与匹配

def scan_assets():
    """扫描 demo_gl/assets，返回 {bg: [...], cg: [...], chars: {前缀: {表情,...}},
    bgm: [...], sfx: [...]}，文件名均含扩展名。"""
    pool = {'bg': [], 'cg': [], 'chars': {}, 'bgm': [], 'sfx': []}
    for sub in ('bg', 'cg', 'bgm', 'sfx'):
        d = os.path.join(SRC_ASSETS, sub)
        if not os.path.isdir(d):
            continue
        exts = IMG_EXTS if sub in ('bg', 'cg') else AUDIO_EXTS
        pool[sub] = sorted(f for f in os.listdir(d)
                           if f.lower().endswith(exts) and not f.endswith('.raw.png'))
    d = os.path.join(SRC_ASSETS, 'chars')
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            # 跳过抠图中间产物，只收正式立绘 <前缀>_<表情>.png
            if not f.lower().endswith('.png') or f.endswith('.raw.png') \
                    or f.endswith('.chroma.png'):
                continue
            m = re.match(r'(.+)_([a-z]+)\.png$', f)
            if m:
                pool['chars'].setdefault(m.group(1), set()).add(m.group(2))
    return pool


def _tokens_of(path_or_name):
    """从文件名/路径提取英文 token 集合。"""
    stem = os.path.splitext(os.path.basename(path_or_name))[0].lower()
    return set(re.split(r'[^a-z0-9]+', stem)) - {''}


def _mood_tokens(text):
    """从中文文本提取氛围英文 token。"""
    out = set()
    for word, toks in MOOD_TOKENS.items():
        if word in text:
            out.update(toks)
    return out


def pick_by_mood(requested, context_text, candidates, used):
    """按文件名 token + 中文氛围词与候选库求交集打分，同分时选使用次数最少的，
    保证同一部游戏里背景尽量不重样。零分时按轮转兜底。"""
    if not candidates:
        return None
    want = _tokens_of(requested) | _mood_tokens(requested + context_text)
    best, best_key = None, None
    for cand in candidates:
        score = len(want & _tokens_of(cand))
        key = (score, -used.get(cand, 0))
        if best_key is None or key > best_key:
            best, best_key = cand, key
    if best_key[0] == 0:  # 零匹配：轮转兜底，避免全是同一张
        best = min(candidates, key=lambda c: used.get(c, 0))
    used[best] = used.get(best, 0) + 1
    return best


def _scene_text(scene):
    """拼场景内全部文本，作为氛围匹配上下文。"""
    parts = [scene.get('id', '')]
    for cmd in scene.get('script', []):
        parts.append(cmd.get('text') or '')
        for o in cmd.get('options', []):
            parts.append(o.get('text') or '')
        show = cmd.get('show')
        if isinstance(show, dict):
            parts.append(show.get('text') or '')
    return ' '.join(parts)


def remap_assets(script, pool):
    """--reuse-assets 核心：把剧本里 LLM 编的素材路径重写到 assets 库现有文件。
    返回 (改写条数, 报告行列表)。直接原地修改 script。"""
    report, n = [], 0
    used = {}  # 文件名 -> 已用次数（背景去重用）

    # 1) 背景
    for scene in script.get('scenes', []):
        bg = scene.get('background')
        if not bg or bg == 'none':
            continue
        ctx = _scene_text(scene)
        hit = pick_by_mood(bg, ctx, pool['bg'], used)
        if hit is None:
            report.append(f"  [素材] scene {scene['id']}: 无背景库，移除 background")
            scene.pop('background', None)
            continue
        new = f"bg/{hit}"
        if new != bg:
            report.append(f"  [素材] {bg} -> {new}")
            scene['background'] = new
            n += 1

    # 2) 立绘：剧本角色按顺序映射到立绘库前缀
    prefixes = sorted(pool['chars'])
    characters = script.get('characters', {})
    if not prefixes:
        report.append("  [素材] 立绘库为空，角色将以剪影占位")
    for i, (cid, cdef) in enumerate(sorted(characters.items())):
        if not prefixes:
            break
        prefix = prefixes[i % len(prefixes)]
        emotions = pool['chars'][prefix]
        sprites = cdef.get('sprites') or {}
        new_sprites = {}
        for emo in sprites:
            use = emo if emo in emotions else 'normal'
            if use not in emotions:
                use = sorted(emotions)[0]
            new_sprites[emo] = f"chars/{prefix}_{use}.png"
        if new_sprites != sprites:
            report.append(f"  [素材] 角色 {cid}（{cdef.get('name')}）立绘 -> 库角色 {prefix}")
            cdef['sprites'] = new_sprites
            n += 1
    # 场景 chars[].sprite 引用的表情若不在该角色 sprites 里，引擎会回退 normal，无需改

    # 3) CG（show.image / inspect.show.image）
    cg_used = {}
    for scene in script.get('scenes', []):
        ctx = _scene_text(scene)
        new_script = []
        for cmd in scene.get('script', []):
            t = cmd.get('type')
            if t == 'show' and cmd.get('image'):
                hit = pick_by_mood(cmd['image'], ctx, pool['cg'], cg_used)
                if hit is None:
                    report.append(f"  [素材] scene {scene['id']}: 无 CG 库，丢弃 show 指令")
                    n += 1
                    continue
                new = f"cg/{hit}"
                if new != cmd['image']:
                    report.append(f"  [素材] {cmd['image']} -> {new}")
                    cmd['image'] = new
                    n += 1
            elif t == 'inspect':
                show = cmd.get('show') or {}
                if show.get('image'):
                    hit = pick_by_mood(show['image'], ctx, pool['cg'], cg_used)
                    if hit is None:
                        report.append(f"  [素材] scene {scene['id']}: 无 CG 库，移除 inspect 配图")
                        show.pop('image', None)
                    else:
                        new = f"cg/{hit}"
                        if new != show['image']:
                            report.append(f"  [素材] {show['image']} -> {new}")
                            show['image'] = new
                        n += 1
            new_script.append(cmd)
        scene['script'] = new_script

    # 4) 音频：库里有则按氛围匹配，没有则剥除（引擎对缺失音频静默跳过，
    #    但剥除后剧本更干净，也避免发布时引用不存在的文件）
    for scene in script.get('scenes', []):
        ctx = _scene_text(scene)
        bgm = scene.get('bgm')
        if bgm:
            src = bgm.get('src') if isinstance(bgm, dict) else bgm
            hit = pick_by_mood(src, ctx, pool['bgm'], {})
            if hit is None:
                report.append(f"  [素材] scene {scene['id']}: 无 BGM 库，剥除 bgm")
                scene.pop('bgm', None)
                n += 1
            elif isinstance(bgm, dict):
                bgm['src'] = f"bgm/{hit}"
            else:
                scene['bgm'] = f"bgm/{hit}"
        sfx = scene.get('sfx')
        if sfx:
            items = sfx if isinstance(sfx, list) else [sfx]
            kept = []
            for it in items:
                src = it.get('src') if isinstance(it, dict) else it
                hit = pick_by_mood(src, ctx, pool['sfx'], {})
                if hit is None:
                    report.append(f"  [素材] scene {scene['id']}: 无 SFX 库，剥除 {src}")
                    n += 1
                    continue
                kept.append({**it, 'src': f"sfx/{hit}"} if isinstance(it, dict)
                            else f"sfx/{hit}")
            if kept:
                scene['sfx'] = kept if isinstance(sfx, list) else kept[0]
            else:
                scene.pop('sfx', None)
    return n, report


# ---------------------------------------------------------------- 剧本校验（复用 script_gen）

def _import_script_gen():
    sys.path.insert(0, REPO_ROOT)
    import script_gen  # noqa: E402  —— 动态路径只能这里导
    return script_gen


def validate_script(script):
    """复用 script_gen 的校验：角色引用 + 悬空 goto + 可达性。返回 (errors, warnings)。"""
    sg = _import_script_gen()
    errors = sg.check_char_refs(script)
    conn_errors, conn_warnings = sg.check_connectivity(script)
    return errors + conn_errors, conn_warnings


# ---------------------------------------------------------------- 剧本生成（复用 script_gen 管线）

def auto_chars(theme):
    """未给 --chars 时，先让 LLM 按题材拟 2-3 张人物卡。"""
    sg = _import_script_gen()
    data = sg.chat_json(
        f"题材：{theme}\n请为这部文游设计 2-3 位主要角色，"
        '输出 JSON：{"chars": [{"name": "姓名", "desc": "一句话人设"}]}。'
        "姓名与人设都要贴合题材。")
    chars = data.get('chars') or []
    if not chars:
        raise RuntimeError("人物卡生成为空")
    return ";".join(f"{c['name']}:{c.get('desc', '')}" for c in chars)


def gen_script_via_api(theme, chars, n_scenes):
    """子进程调 script_gen.py 跑完整生成管线（大纲→逐幕→校验修复）。"""
    if not chars:
        print("[0/4] 未指定 --chars，先让 AI 拟人物卡 ...")
        chars = auto_chars(theme)
        print(f"  人物卡：{chars}")
    fd, tmp = tempfile.mkstemp(suffix='.json', prefix='autonovel_')
    os.close(fd)
    try:
        cmd = [sys.executable, SCRIPT_GEN, '--theme', theme,
               '--chars', chars, '--scenes', str(n_scenes), '--out', tmp]
        print("[1/4] 调 script_gen.py 生成剧本 ...")
        r = subprocess.run(cmd, cwd=REPO_ROOT)
        if r.returncode != 0:
            sys.exit("[失败] script_gen.py 未通过，见上方输出")
        with open(tmp, encoding='utf-8') as f:
            return json.load(f), chars
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ---------------------------------------------------------------- 游戏变体构建（build.py 等效）

def collect_refs(script):
    """收集剧本引用的全部素材相对路径，按子目录分组。"""
    refs = {'bg': set(), 'cg': set(), 'chars': set(), 'bgm': set(), 'sfx': set()}

    def add(path):
        if not path or not isinstance(path, str):
            return
        sub = path.split('/', 1)[0]
        if sub in refs and '/' in path:
            refs[sub].add(path)

    for cdef in script.get('characters', {}).values():
        for v in (cdef.get('sprites') or {}).values():
            if isinstance(v, dict):  # 套装×表情扩展格式
                for p in v.values():
                    add(p)
            else:
                add(v)
    for scene in script.get('scenes', []):
        bg = scene.get('background')
        if bg and bg != 'none':
            add(bg)
        bgm = scene.get('bgm')
        if isinstance(bgm, dict):
            add(bgm.get('src'))
        else:
            add(bgm)
        sfx = scene.get('sfx')
        for it in (sfx if isinstance(sfx, list) else [sfx] if sfx else []):
            add(it.get('src') if isinstance(it, dict) else it)
        for cmd in scene.get('script', []):
            if cmd.get('type') == 'show':
                add(cmd.get('image'))
            elif cmd.get('type') == 'inspect':
                add((cmd.get('show') or {}).get('image'))
    return refs


def convert_image(src, dst, max_side, quality):
    """单张图片转 WebP（逻辑同 tools/build.py）。"""
    from PIL import Image
    img = Image.open(src)
    has_alpha = img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info)
    img = img.convert('RGBA' if has_alpha else 'RGB')
    if max(img.size) > max_side:
        r = max_side / max(img.size)
        img = img.resize((max(1, round(img.width * r)), max(1, round(img.height * r))),
                         Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    img.save(dst, 'WEBP', quality=quality, method=6)


def render_html(script):
    """读 index.html 模板（只读！），替换 EMBEDDED_SCRIPT 与 <title>，
    并把 bg/cg/chars 引用改写成 .webp（同 build.py 的正则）。"""
    with open(TEMPLATE_HTML, encoding='utf-8') as f:
        html = f.read()
    payload = json.dumps(script, ensure_ascii=False)
    payload = payload.replace('</', '<\\/')  # 防剧本文本里的 </script> 截断 HTML
    html, cnt = re.subn(r'^const EMBEDDED_SCRIPT = .*;$',
                        'const EMBEDDED_SCRIPT = ' + payload + ';',
                        html, count=1, flags=re.M)
    if cnt != 1:
        raise RuntimeError("模板 index.html 中未找到唯一的 EMBEDDED_SCRIPT 赋值行")
    title = re.escape(str(script.get('meta', {}).get('title', '')))
    html = re.sub(r'<title>.*?</title>', '<title>' + title + '</title>', html, count=1)
    html = re.sub(r"((?:bg|cg|chars)/[^'\"()\\]+?)\.(?:png|jpg|jpeg)", r'\1.webp', html)
    return html


def build_game(script, out_dir, assets_root):
    """生成自包含游戏目录：index.html + script.json + assets/(webp 图片 + 原样音频)。
    assets_root 为素材源目录（reuse 模式是 demo_gl/assets，gen 模式是 out_dir/assets）。"""
    refs = collect_refs(script)
    os.makedirs(out_dir, exist_ok=True)

    # 图片转 WebP（build.py 等效）
    n_img, missing = 0, []
    for sub, (side, q) in IMG_RULES.items():
        for rel in sorted(refs[sub]):
            src = os.path.join(assets_root, rel)
            if not os.path.exists(src):
                missing.append(rel)
                continue
            dst = os.path.join(out_dir, 'assets',
                               os.path.splitext(rel)[0] + '.webp')
            if assets_root == os.path.join(out_dir, 'assets'):
                # gen 模式：素材已生成在输出目录里，转换后删掉原图
                convert_image(src, dst, side, q)
                if os.path.abspath(src) != os.path.abspath(dst):
                    os.remove(src)
            else:
                convert_image(src, dst, side, q)
            n_img += 1

    # 音频原样拷贝
    n_audio = 0
    for sub in ('bgm', 'sfx'):
        for rel in sorted(refs[sub]):
            src = os.path.join(assets_root, rel)
            if not os.path.exists(src):
                missing.append(rel)
                continue
            dst = os.path.join(out_dir, 'assets', rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.abspath(src) != os.path.abspath(dst):
                shutil.copy2(src, dst)
            n_audio += 1

    html = render_html(script)
    with open(os.path.join(out_dir, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)
    with open(os.path.join(out_dir, 'script.json'), 'w', encoding='utf-8') as f:
        json.dump(script, f, ensure_ascii=False, indent=2)
    return n_img, n_audio, missing


def slugify(theme):
    """题材 -> 目录名（保留中文，剔除 Windows 非法字符）。"""
    s = re.sub(r'[\\/:*?"<>|\s]+', '_', theme).strip('._')
    return s or 'untitled'


# ---------------------------------------------------------------- 自测

def self_test():
    print("== autonovel self-test（不调 API）==")

    # 1) 素材库扫描
    pool = scan_assets()
    assert pool['bg'] and pool['chars'], "demo_gl/assets 素材库为空？"
    print(f"  素材库扫描 OK：bg {len(pool['bg'])} 张，立绘角色 {sorted(pool['chars'])}，"
          f"cg {len(pool['cg'])} 张")

    # 2) 氛围匹配：雨夜山门 -> 应命中含 rain 或 night 的背景
    used = {}
    hit = pick_by_mood('bg/mountain_gate_rainy_night.jpg', '雨夜 山门', pool['bg'], used)
    assert _tokens_of(hit) & {'rain', 'rainy', 'night'}, hit
    print(f"  氛围匹配 OK：mountain_gate_rainy_night -> {hit}")

    # 3) remap 假剧本：所有引用必须落到真实存在的文件
    script = fake_script()
    n, report = remap_assets(script, pool)
    for line in report:
        print(line)
    refs = collect_refs(script)
    for sub in refs:
        for rel in refs[sub]:
            assert os.path.exists(os.path.join(SRC_ASSETS, rel)), f"重写后仍指向缺失文件 {rel}"
    assert not refs['bgm'] and not refs['sfx'], "无音频库时应剥除 bgm/sfx"
    print(f"  素材重写 OK（{n} 处），全部引用落在现有文件上")

    # 4) 校验：假剧本零错误；再构造悬空 goto 必须被检出
    errors, warns = validate_script(script)
    assert not errors, errors
    broken = json.loads(json.dumps(script))
    broken['scenes'][0]['script'][-1]['options'][0]['goto'] = 'ghost_scene'
    errors2, _ = validate_script(broken)
    assert any('悬空 goto' in e for e in errors2), errors2
    print("  剧本校验 OK（合法零错误 / 悬空 goto 可检出）")

    # 5) 构建变体到临时目录并验证产物
    tmp = tempfile.mkdtemp(prefix='autonovel_test_')
    try:
        n_img, n_audio, missing = build_game(script, tmp, SRC_ASSETS)
        assert not missing, missing
        html = open(os.path.join(tmp, 'index.html'), encoding='utf-8').read()
        assert '自测·山门悬案' in html and '<title>自测·山门悬案</title>' in html
        assert '她的山间灯火' not in html.split('EMBEDDED_SCRIPT', 2)[1][:200]
        # 剧本区引用应全部 .webp 化
        payload = html.split('const EMBEDDED_SCRIPT = ', 1)[1].split(';\n', 1)[0]
        assert not re.search(r'(bg|cg|chars)/[^"\']+\.(png|jpg)', payload), "仍有非 webp 引用"
        webps = [f for dp, _, fs in os.walk(os.path.join(tmp, 'assets'))
                 for f in fs if f.endswith('.webp')]
        assert len(webps) == n_img and n_img > 0
        # 模板本体未被改动
        assert '她的山间灯火' in open(TEMPLATE_HTML, encoding='utf-8').read()
        print(f"  变体构建 OK：index.html + {n_img} 张 webp + script.json，模板未动")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # 6) slugify
    assert slugify('修仙 山门/悬案?') == '修仙_山门_悬案'
    print("  slugify OK")
    print("== self-test 全部通过 ==")


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(description="本地一键自主小说：题材 -> 可发布游戏")
    ap.add_argument("theme", nargs="?", help="一句话题材，如：修仙山门悬案")
    ap.add_argument("--chars", help='人物卡："名字:描述;名字:描述"（缺省让 AI 拟）')
    ap.add_argument("--scenes", type=int, default=5, help="目标场景数（默认 5）")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--reuse-assets", action="store_true",
                      help="复用现有素材库智能匹配（默认，零成本）")
    mode.add_argument("--gen-assets", action="store_true",
                      help="调 assets_gen.py 生成新素材（需 API，花钱）")
    ap.add_argument("--out-dir", help="输出目录（默认 games_output/<题材>/）")
    ap.add_argument("--dry-run", action="store_true",
                    help="预览全流程（用内置假剧本演示素材匹配），不调 API 不写盘")
    ap.add_argument("--self-test", action="store_true", help="内置假剧本自测")
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return

    # --dry-run：用假剧本演示匹配与校验，不写任何文件
    if args.dry_run:
        print("== dry-run 预览（不调 API，不写盘）==")
        print(f"题材：{args.theme or '(未提供)'}  场景数：{args.scenes}  "
              f"素材策略：{'gen-assets' if args.gen_assets else 'reuse-assets（默认）'}")
        out_dir = args.out_dir or os.path.join(OUT_ROOT, slugify(args.theme or 'untitled'))
        print(f"预计输出目录：{out_dir}")
        print("\n正式运行时将执行：")
        print("  [1/4] python script_gen.py 生成剧本（大纲→逐幕→校验修复）")
        if args.gen_assets:
            print("  [2/4] python assets_gen.py 按剧本生成素材")
        else:
            print("  [2/4] 素材重写：从 assets 库按氛围匹配（下为用假剧本的演示）")
        print("  [3/4] 校验：角色引用 / 悬空 goto / 可达性")
        print("  [4/4] 以 index.html 为模板生成游戏变体 + WebP 转换")
        if not args.gen_assets:
            pool = scan_assets()
            script = fake_script()
            _, report = remap_assets(script, pool)
            print("\n-- 素材匹配演示（假剧本《自测·山门悬案》）--")
            for line in report:
                print(line)
            errors, warns = validate_script(script)
            print(f"校验演示：{len(errors)} 错误 / {len(warns)} 告警")
        print("\n== dry-run 完成，未调用 API、未写任何文件 ==")
        return

    if not args.theme:
        ap.error("必须提供题材（或用 --self-test / --dry-run）")

    out_dir = args.out_dir or os.path.join(OUT_ROOT, slugify(args.theme))

    # ① 生成剧本
    script, chars = gen_script_via_api(args.theme, args.chars, args.scenes)
    print(f"  剧本《{script.get('meta', {}).get('title')}》："
          f"{len(script.get('scenes', []))} 个 scene")

    # ② 素材策略
    if args.gen_assets:
        print("[2/4] 调 assets_gen.py 生成素材 ...")
        raw_path = os.path.join(out_dir, 'script.json')
        os.makedirs(out_dir, exist_ok=True)
        with open(raw_path, 'w', encoding='utf-8') as f:
            json.dump(script, f, ensure_ascii=False, indent=2)
        r = subprocess.run([sys.executable, ASSETS_GEN, '--script', raw_path],
                           cwd=REPO_ROOT)
        if r.returncode != 0:
            sys.exit("[失败] assets_gen.py 未通过，见上方输出")
        assets_root = os.path.join(out_dir, 'assets')
    else:
        print("[2/4] 素材重写：从 assets 库按氛围匹配 ...")
        pool = scan_assets()
        n, report = remap_assets(script, pool)
        for line in report:
            print(line)
        print(f"  共重写 {n} 处引用")
        assets_root = SRC_ASSETS

    # ③ 校验
    print("[3/4] 校验剧本 ...")
    errors, warns = validate_script(script)
    for w in warns:
        print(f"  [告警] {w}")
    if errors:
        for e in errors:
            print(f"  [错误] {e}")
        sys.exit("[失败] 校验未通过")
    print("  校验通过")

    # ④ 生成游戏变体
    print(f"[4/4] 生成游戏变体 -> {out_dir} ...")
    n_img, n_audio, missing = build_game(script, out_dir, assets_root)
    for rel in missing:
        print(f"  [告警] 素材缺失，引擎将降级占位：{rel}")
    print(f"  完成：index.html + {n_img} 张 webp + {n_audio} 个音频 + script.json")
    print(f"\n双击 {os.path.join(out_dir, 'index.html')} 即可游玩《{args.theme}》")


if __name__ == '__main__':
    main()
