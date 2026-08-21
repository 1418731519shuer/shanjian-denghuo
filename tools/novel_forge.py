#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""剧本生成器（NovelForge）—— 多轮 LLM 写作管线，产出多角色多路线多结局的完整文游。

设计见 docs/novel_forge_design.md。五阶段：
  ① 企划（世界观+8角色卡）② 总纲（分幕，每幕声明场景背景）③ 写作（主线3幕+8角色路线+8专属结局）
  ④ 素材（阶跃出图：绿幕立绘→rembg 透明抠图；场景背景）⑤ 校验 + 续写分析报告

用法（demo_gl 目录下）：
  python tools/novel_forge.py --theme "仙侠"                 # 全流程（LLM 35+ 轮 + 出图）
  python tools/novel_forge.py --theme "仙侠" --skip-assets   # 只出文字版（复用现有素材映射）
  python tools/novel_forge.py --dry-run                      # 只打印管线计划
LLM 用 step-explore（Anthropic Messages 通道，Step Plan key 同 script_gen）。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO_DIR = os.path.dirname(HERE)                      # demo_gl/
WENYOU_DIR = os.path.dirname(DEMO_DIR)                # wenyou/
STEP_KEY_FILE = r"E:/user/content_factory/secrets/step_api_key.txt"
MESSAGES_URL = "https://api.stepfun.com/step_plan/v1/messages"
EXPLORE_MODEL = "step-explore"
MAX_TOKENS = 16384
ROUTE_EMOTIONS = ("normal", "smile", "sad")           # 每角色立绘表情（可再加）

sys.path.insert(0, WENYOU_DIR)
sys.path.insert(0, HERE)


# ---------------------------------------------------------------- LLM（step-explore / Messages 协议）
def _key():
    if os.environ.get("STEP_API_KEY"):
        return os.environ["STEP_API_KEY"].strip()
    return open(STEP_KEY_FILE, encoding="utf-8").read().strip()


def chat_explore(prompt, system=None, max_tokens=MAX_TOKENS, retry=3):
    """调 step-explore（Messages 协议），返回文本。网络抖动自动重试。"""
    import urllib.request
    body = {"model": EXPLORE_MODEL, "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}]}
    if system:
        body["system"] = system
    data = json.dumps(body, ensure_ascii=False).encode()
    last = None
    for attempt in range(retry):
        req = urllib.request.Request(MESSAGES_URL, data=data, headers={
            "x-api-key": _key(), "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.loads(r.read())
            texts = [b.get("text", "") for b in d.get("content", []) if b.get("type") == "text"]
            return "\n".join(texts).strip()
        except Exception as e:
            code = getattr(e, "code", None)
            if code is not None and 400 <= code < 500:
                raise
            last = e
            print(f"    [网络重试 {attempt + 1}/{retry}] {type(e).__name__}")
            time.sleep(2 * (attempt + 1))
    raise last


ROUND = [0]   # 全局轮次计数


def chat_json(prompt, system=None, retry_parse=3):
    """chat_explore + JSON 抽取重试（把解析错误喂回模型）。"""
    ROUND[0] += 1
    print(f"  [轮次 {ROUND[0]}] {prompt.splitlines()[0][:40]}…")
    err = None
    for _ in range(retry_parse):
        text = chat_explore(prompt + (f"\n\n上次输出解析失败：{err}\n请只输出合法 JSON。" if err else ""),
                            system=system)
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception as e:
                err = e
        else:
            err = "未找到 JSON 对象"
    raise RuntimeError(f"JSON 生成重试 {retry_parse} 次仍失败：{err}")


SYS = ("你是顶级中文互动小说编剧，擅长仙侠题材、多角色群像与分支叙事。"
       "你只输出 JSON，不输出任何多余文字。JSON 字符串内不使用未转义换行。")


# ---------------------------------------------------------------- 五阶段管线
def stage_concept(theme, n_chars):
    """① 企划：世界观 + 角色卡（2 轮）。"""
    print("[1/5] 企划：世界观 + 角色卡 …")
    world = chat_json(
        f"题材：{theme}（仙侠）。请设计世界观："
        '{"worldview": {"name":"…","setting":"…(200字内)","tone":"…","factions":["…"]},'
        '"main_conflict":"…(80字内)"}', system=SYS)
    chars = chat_json(
        f"题材：{theme}（仙侠）。世界观：{json.dumps(world, ensure_ascii=False)}\n"
        f"请设计 {n_chars} 个主要角色，要求：① 全部是女性；② 出身/秘密/动机各不相同，有正派有邪道有中立；"
        f"③ 玩家角色是**女主**（修仙者），每个角色和女主的**关系必须不同**"
        f"（同门师姐/青梅竹马/宿敌/救命恩人/师尊/半路捡的徒弟/神秘间谍/妖族公主……不许重复）；"
        f"④ 每人一条独立「人物路线」主题和一个专属结局走向（与她和女主的关系呼应）。\n"
        '输出：{"characters":[{"id":"c1","name":"…","gender":"女","look":"…(外貌60字，给画师从脸到衣饰)",'
        '"relation":"与女主的关系(8字内)","background":"…(出身100字)","secret":"…","motive":"…","route":"路线主题(10字)",'
        '"ending_hint":"专属结局走向(30字)","favor_color":"#RRGGBB"}]}', system=SYS)
    cards = chars.get("characters", [])
    if len(cards) < n_chars:
        raise RuntimeError(f"角色卡只有 {len(cards)} 张 < {n_chars}")
    return world, cards


def stage_outline(theme, world, cards):
    """② 总纲：分幕，每幕声明场景背景（1 轮）。"""
    print("[2/5] 总纲：分幕大纲（含场景声明）…")
    names = "；".join(f"{c['id']}={c['name']}（{c['route']}）" for c in cards)
    ol = chat_json(
        f"题材：{theme}。世界观：{json.dumps(world, ensure_ascii=False)}\n角色：{names}\n"
        "请写总纲：主线三幕（起/承/转），转幕末尾玩家选择进入哪个角色的人物路线。\n"
        '输出：{"acts":[{"id":"act1","title":"…","summary":"…(80字)",'
        '"background":"bg/英文小写_slug.jpg（本幕主要场景背景图）","key_chars":["c1"]}]},'
        " 主线三幕都要给 background，且说明哪段剧情发生在哪个场景。", system=SYS)
    if len(ol.get("acts", [])) < 3:
        raise RuntimeError("主线不足三幕")
    return ol


SCENE_HINT = (
    'scene JSON 格式：{"id":"…","background":"bg/xx.jpg","checkpoint":true,'
    '"chars":[{"id":"c1","pos":"left|center|right","sprite":"normal|smile|sad"}],'
    '"script":[ {"type":"narrate","text":"…"}, {"type":"say","who":"c1","text":"…"},'
    '{"type":"set","vars":{"favor_c1":"favor_c1+5"}},'
    '{"type":"choice","options":[{"text":"…","goto":"场景id","set":{"k":"k+1"},"if":"favor_c1>=10"}]},'
    '{"type":"goto","target":"场景id"}, {"type":"end","label":"结局名"} ]}\n'
    "规则：say.who 必须在 chars 站位表；goto/选项 goto 只能指向列出的场景 id；"
    "每场景 script 6-12 条；选项要有数值条件（if）和变量增减（set）。")


CACHE = os.path.join(DEMO_DIR, "games_output", "_forge_cache.json")

def stage_write(theme, world, cards, outline):
    """③ 写作：主线 3 幕 + 每角色 1 轮（路线+结局）。带断点缓存。"""
    print("[3/5] 写作：主线 + 角色路线 + 专属结局 …")
    cache = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE, encoding="utf-8"))
        except Exception:
            cache = {}
    scenes = cache.get("scenes", [])
    done_parts = set(cache.get("done_parts", []))

    def save():
        cache["scenes"] = scenes
        cache["done_parts"] = sorted(done_parts)
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)

    base = (f"题材：{theme}。世界观：{json.dumps(world, ensure_ascii=False)}\n"
            f"玩家角色：女主（修仙者）。所有角色均为女性，写作时体现各自与女主不同的关系。\n"
            f"角色卡：{json.dumps(cards, ensure_ascii=False)}\n")

    act_ids = [a["id"] for a in outline["acts"]]
    # 主线三幕：act1→act2→act3，act3 末尾选项进路线（flag route_cX=1）
    for i, act in enumerate(outline["acts"]):
        if f"act{i}" in done_parts:
            continue
        nxt = act_ids[i + 1] if i + 1 < len(act_ids) else None
        guide = (f"这是主线第 {i + 1}/3 幕。本幕场景背景用 {act.get('background')}。")
        if nxt:
            guide += f"结尾用 goto 进入 {nxt}。"
        else:
            routes = "、".join(f"route_{c['id']}" for c in cards)
            guide += (f"这是主线收束幕，结尾必须是一个 choice：每个选项选择一个角色路线，"
                      f"set 对应 flag（{routes}，如 {{\"route_c1\":1}}），且所有选项都不带 goto"
                      f"（路线场景靠 require 门进入）。")
        data = chat_json(base + f"本幕大纲：{json.dumps(act, ensure_ascii=False)}\n{guide}\n"
                         + SCENE_HINT + f'\n输出：{{"scenes":[…]}}，scene id 用 {act["id"]}_xxx。', system=SYS)
        scenes += data.get("scenes", [])
        done_parts.add(f"act{i}"); save()

    # 角色路线+专属结局：每角色 1 轮，线程池并发（阶跃 API 可并发）
    from concurrent.futures import ThreadPoolExecutor
    import threading
    lock = threading.Lock()

    def write_route(c):
        if f"route_{c['id']}" in done_parts:
            return
        r1, eid = f"route_{c['id']}_1", f"end_{c['id']}"
        try:
            data = chat_json(
                base + f"现在一口气写完角色 {c['name']}（{c['id']}）的路线与专属结局，共两个场景。\n"
                f"她的路线主题：{c['route']}；与女主的关系：{c.get('relation', '')}；"
                f"背景：{c['background']}；秘密：{c['secret']}；结局走向：{c['ending_hint']}。\n"
                f"场景一 id={r1}（路线入口，加 require 门 route_{c['id']}==1，结尾 goto {eid}；"
                f"内含 favor_{c['id']} 的增减与带条件的选项）。\n"
                f"场景二 id={eid}（专属结局，require 门同上，最后一条指令是 end，"
                f"label 用「结局·二字或四字雅名」）。\n"
                + SCENE_HINT + '\n输出：{"scenes":[路线场景, 结局场景]}。', system=SYS)
        except RuntimeError:
            print(f"  [兜底] {c['name']} 合并生成失败，拆分为两轮")
            d1 = chat_json(
                base + f"写角色 {c['name']}（{c['id']}）的路线场景，id={r1}，"
                f"加 require 门 route_{c['id']}==1，结尾 goto {eid}，"
                f"内含 favor_{c['id']} 增减与条件选项。路线主题：{c['route']}。\n"
                + SCENE_HINT + '\n输出：{"scenes":[…]}（就这一个场景）。', system=SYS)
            d2 = chat_json(
                base + f"写角色 {c['name']}（{c['id']}）的专属结局场景，id={eid}，"
                f"require 门同上，最后一条为 end，label 用「结局·雅名」。"
                f"结局走向：{c['ending_hint']}。\n"
                + SCENE_HINT + '\n输出：{"scenes":[…]}（就这一个场景）。', system=SYS)
            data = {"scenes": d1.get("scenes", []) + d2.get("scenes", [])}
        with lock:
            scenes.extend(data.get("scenes", []))
            done_parts.add(f"route_{c['id']}")
            save()

    todo = [c for c in cards if f"route_{c['id']}" not in done_parts]
    if todo:
        with ThreadPoolExecutor(max_workers=min(6, len(todo))) as ex:
            list(ex.map(write_route, todo))
    return scenes


def assemble(theme, world, cards, scenes):
    """组装完整剧本 JSON：属性（每角色好感+主控修为/魅力）、角色、场景。"""
    attrs = {}
    for c in cards:
        attrs[f"favor_{c['id']}"] = {"name": f"{c['name']}好感", "init": 0, "min": 0, "max": 100,
                                     "bar": c.get("favor_color", "#FFB6C1"), "owner": c["id"]}
    attrs["xiuwei"] = {"name": "修为", "init": 10, "min": 0, "max": 100, "bar": "#9be7ff", "owner": "player"}
    attrs["charm"] = {"name": "魅力", "init": 10, "min": 0, "max": 100, "bar": "#F0E68C", "owner": "player"}
    characters = {}
    for c in cards:
        characters[c["id"]] = {
            "name": c["name"], "color": c.get("favor_color", "#FFB6C1"),
            "look": c.get("look", ""),
            "sprites": {e: f"chars/{c['id']}_{e}.png" for e in ROUTE_EMOTIONS},
        }
    return {
        "meta": {"title": f"{theme}·群像传", "author": "剧本生成器", "version": "1.0",
                 "defaults": {"text_speed": 25, "bgm_volume": 0.5, "auto_delay": 1800}},
        "attrs": attrs, "characters": characters,
        "assets_dir": "assets/", "scenes": scenes,
    }


def repair_links(script, cards, report):
    """写作后修复：LLM 常见的引用错误程序化纠偏。
    1) 角色 id 纠偏：player→女主卡（没有则补建）、c0/c9 等越界 id 夹紧到 c1..cN
    2) 跳转目标纠偏：act2 → act2_ 前缀首个场景；route_cX → route_cX_1
    3) 路线调度：主线末幕选项统一 goto route_dispatch，并插入调度场景（按 flag 条件分发）
    """
    ids = {s["id"] for s in script["scenes"]}
    char_ids = list(script["characters"].keys())

    # --- 1) 角色 id 纠偏 ---
    if "player" not in script["characters"]:
        script["characters"]["player"] = {
            "name": "我", "color": "#ffffff", "look": "",
            "sprites": {e: f"chars/{char_ids[0]}_{e}.png" for e in ROUTE_EMOTIONS}}
        report.append("补建女主角色卡 player（立绘暂借第一位角色，可后期单独出图）")

    def fix_cid(cid):
        if cid in script["characters"]:
            return cid
        m = re.match(r"^c(\d+)$", str(cid))
        if m:
            n = min(max(int(m.group(1)), 1), len(cards))
            return f"c{n}"
        return "player" if str(cid).lower() in ("player", "mc", "女主") else char_ids[0]

    for s in script["scenes"]:
        for ch in s.get("chars") or []:
            fixed = fix_cid(ch.get("id"))
            if fixed != ch.get("id"):
                report.append(f"{s['id']}: 站位角色 {ch.get('id')} -> {fixed}")
                ch["id"] = fixed
        for cmd in s.get("script") or []:
            if cmd.get("type") == "say" and cmd.get("who"):
                fixed = fix_cid(cmd["who"])
                if fixed != cmd["who"]:
                    report.append(f"{s['id']}: 说话人 {cmd['who']} -> {fixed}")
                    cmd["who"] = fixed

    # --- 2) 跳转目标纠偏 ---
    def fix_target(ref, cur_sid):
        if not ref:
            return ref
        scene_part, sep, anchor = ref.partition(":")
        if scene_part in ids:
            return ref
        # route_cX → route_cX_1
        if re.match(r"^route_c\d+$", scene_part) and scene_part + "_1" in ids:
            return scene_part + "_1" + (sep + anchor if sep else "")
        # actN → actN_ 前缀首个场景
        pref = [s["id"] for s in script["scenes"] if s["id"].startswith(scene_part + "_")]
        if pref:
            return pref[0] + (sep + anchor if sep else "")
        # 同场景锚点
        if scene_part == "" and anchor:
            return ref
        # route_cX_2（旧两幕路线写法）→ end_cX
        m2 = re.match(r"^route_(c\d+)_2$", scene_part)
        if m2 and f"end_{m2.group(1)}" in ids:
            return f"end_{m2.group(1)}"
        # 同幕前缀就近：act2_xxx → act2_ 首个场景
        pref2 = [s["id"] for s in script["scenes"]
                 if s["id"].split("_")[0] == scene_part.split("_")[0] and "_" in scene_part]
        if pref2:
            return pref2[0] + (sep + anchor if sep else "")
        return ref  # 修不了的留给校验报

    for s in script["scenes"]:
        for cmd in s.get("script") or []:
            if cmd.get("type") == "goto" and cmd.get("target"):
                cmd["target"] = fix_target(cmd["target"], s["id"])
            if cmd.get("type") == "choice":
                for o in cmd.get("options") or []:
                    if o.get("goto"):
                        o["goto"] = fix_target(o["goto"], s["id"])

    # --- 2.5) require 归一化（LLM 会写成对象 {k:v}/{k:"==1"}，引擎要表达式字符串） ---
    for s in script["scenes"]:
        req = s.get("require")
        if isinstance(req, dict):
            parts = []
            for k, v in req.items():
                if isinstance(v, str) and v.startswith(("==", ">=", "<=", "!=", ">", "<")):
                    parts.append(f"{k}{v}")
                else:
                    parts.append(f"{k}=={json.dumps(v)}")
            s["require"] = " && ".join(parts)
            report.append(f"{s['id']}: require 对象 -> 表达式 {s['require']}")
        elif req is not None and not isinstance(req, str):
            s["require"] = str(req)

    # --- 2.6) 路线选项解除好感锁（锁死=玩家到不了任何路线，硬性 bug） ---
    for s in script["scenes"]:
        for cmd in s.get("script") or []:
            if cmd.get("type") != "choice":
                continue
            for o in cmd.get("options") or []:
                if (o.get("set") and o.get("if")
                        and re.match(r"^favor_c\d+>=\d+$", o["if"])
                        and any(k.startswith("route_") for k in o["set"])):
                    del o["if"]
                    report.append(f"{s['id']}: 路线选项解除好感锁「{(o.get('text') or '')[:10]}」")

    # --- 2.7) 结局名清理（LLM 有时把模板串写进 label） ---
    for s in script["scenes"]:
        for cmd in s.get("script") or []:
            if cmd.get("type") == "end":
                label = cmd.get("label", "")
                if re.search(r'[=?:{}\[\]"]', label):
                    m = re.search(r'"([^"]{2,12})"', label) or re.search(r'「([^」]{2,12})」', label)
                    new = m.group(1) if m else re.sub(r'[^一-鿿·]', '', label)[:12]
                    if not new.startswith("结局"):
                        new = "结局·" + new.lstrip("结局·")
                    cmd["label"] = new
                    report.append(f"{s['id']}: 结局名清理 -> {new}")

    # --- 2.8) 自引用回环解除：选项/goto 跳回自己所在场景 = 死循环，改为顺序继续 ---
    for s in script["scenes"]:
        for cmd in s.get("script") or []:
            refs = []
            if cmd.get("type") == "goto":
                refs.append(cmd)
            if cmd.get("type") == "choice":
                refs.extend(cmd.get("options") or [])
            for r in refs:
                g = r.get("target") or r.get("goto")
                if g and g.split(":")[0] == s["id"]:
                    if "target" in r:
                        del r["target"]
                    else:
                        del r["goto"]
                    report.append(f"{s['id']}: 解除自引用回环（{cmd['type']}）")

    # --- 3) 路线调度场景 ---
    route_flags = [f"route_{c['id']}" for c in cards]
    first_route = {f: f"route_{c['id']}_1" for f, c in zip(route_flags, cards)}
    if all(f"route_{c['id']}_1" in ids for c in cards) and "route_dispatch" not in ids:
        dispatch = {"id": "route_dispatch", "background": "none", "chars": [],
                    "script": [{"type": "goto", "target": first_route[f], "if": f"{f}==1"}
                               for f in route_flags]}
        # 兜底：什么 flag 都没有时进第一条路线
        dispatch["script"].append({"type": "goto", "target": first_route[route_flags[0]]})
        # 插到主线末幕之后
        main_last = max(i for i, s in enumerate(script["scenes"]) if s["id"].startswith("act"))
        script["scenes"].insert(main_last + 1, dispatch)
        ids.add("route_dispatch")
        # 末幕选项：设 flag 后统一进调度
        last_act = script["scenes"][main_last]
        for cmd in last_act.get("script") or []:
            if cmd.get("type") == "choice":
                for o in cmd.get("options") or []:
                    if o.get("set"):
                        o["goto"] = "route_dispatch"
        report.append("已插入路线调度场景 route_dispatch")
    return script


def stage_validate(script):
    """⑤a 结构校验：复用 autonovel.validate_script。"""
    import autonovel
    errors, warnings = autonovel.validate_script(script)
    return errors, warnings


def stage_extension_report(theme, script):
    """⑤b 续写分析：LLM 审查可拓展点（1 轮）。"""
    print("[5/5] 续写分析 …")
    brief = json.dumps(
        [{"id": s["id"], "choices": sum(1 for c in s.get("script", []) if c.get("type") == "choice"),
          "ends": sum(1 for c in s.get("script", []) if c.get("type") == "end")} for s in script["scenes"]],
        ensure_ascii=False)
    rep = chat_explore(
        f"这是一部仙侠互动剧本的结构清单：{brief}\n角色："
        + "、".join(c["name"] for c in script["characters"].values())
        + "\n请以策划视角列出 v2 可拓展点：哪些场景可以加分支选项、哪些角色路线可以加深、"
          "可以加什么新结局或隐藏路线。输出中文要点清单（8-12 条，每条一行）。", system=SYS)
    return rep


# ---------------------------------------------------------------- 素材（④）
def stage_assets(script, out_dir, style="guofeng"):
    """④ 素材：把剧本写到 out_dir，调 assets_gen 出图（绿幕立绘→rembg 透明）。"""
    script_path = os.path.join(out_dir, "script.json")
    os.makedirs(out_dir, exist_ok=True)
    with open(script_path, "w", encoding="utf-8") as f:
        json.dump(script, f, ensure_ascii=False, indent=2)
    assets_gen = os.path.join(WENYOU_DIR, "assets_gen.py")
    cmd = [sys.executable, assets_gen, "--script", script_path, "--style", style]
    print("[4/5] 出图（阶跃 step-image-edit-2 + rembg 透明抠图）…  这可能要十几分钟")
    r = subprocess.run(cmd, cwd=WENYOU_DIR)
    return r.returncode == 0


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="剧本生成器 NovelForge")
    ap.add_argument("--theme", default="仙侠问道")
    ap.add_argument("--chars", type=int, default=8)
    ap.add_argument("--skip-assets", action="store_true", help="不出图（只生成剧本+变体，素材走复用映射）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.dry_run:
        print("管线计划：①企划2轮 → ②总纲1轮 → ③写作(3主线+16路线+8结局=27轮) → "
              "④素材出图 → ⑤校验+续写分析1轮；LLM 合计 ≈31 轮，模型 step-explore")
        return

    t0 = time.time()
    cache = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE, encoding="utf-8"))
        except Exception:
            cache = {}
    if cache.get("theme") == args.theme and cache.get("world") and cache.get("cards") and cache.get("outline"):
        world, cards, outline = cache["world"], cache["cards"], cache["outline"]
        print("  [缓存] 企划/总纲沿用上次（角色一致）")
    else:
        world, cards = stage_concept(args.theme, args.chars)
        print(f"  角色：{'、'.join(c['name'] for c in cards)}")
        outline = stage_outline(args.theme, world, cards)
        print(f"  主线：{' → '.join(a['title'] for a in outline['acts'])}")
        cache.update({"theme": args.theme, "world": world, "cards": cards, "outline": outline})
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    scenes = stage_write(args.theme, world, cards, outline)
    print(f"  场景共 {len(scenes)} 个")

    script = assemble(args.theme, world, cards, scenes)
    fix_log = []
    script = repair_links(script, cards, fix_log)
    for line in fix_log:
        print("  [修复]", line)
    errors, warnings = stage_validate(script)
    for w in warnings[:10]:
        print("  [告警]", w)
    if errors:
        for e in errors[:10]:
            print("  [错误]", e)
        sys.exit("校验未通过（保留中间产物便于排查）")

    out_dir = os.path.join(DEMO_DIR, "games_output", f"{args.theme}·群像传")
    if args.skip_assets:
        import autonovel
        pool = autonovel.scan_assets()
        autonovel.remap_assets(script, pool)
        n_img, n_audio, missing = autonovel.build_game(script, out_dir, autonovel.SRC_ASSETS)
        print(f"[4/5] 跳过出图，复用素材映射（{n_img} 图 {n_audio} 音频，缺 {len(missing)}）")
    else:
        if stage_assets(script, out_dir):
            import autonovel
            n_img, n_audio, missing = autonovel.build_game(script, out_dir, os.path.join(out_dir, "assets"))
            print(f"  变体完成：{n_img} 图 {n_audio} 音频，缺 {len(missing)}")
        else:
            sys.exit("出图失败（可 --skip-assets 先玩文字版）")

    rep = stage_extension_report(args.theme, script)
    with open(os.path.join(out_dir, "extension_report.md"), "w", encoding="utf-8") as f:
        f.write(f"# 《{script['meta']['title']}》v2 扩展建议\n\n" + rep + "\n")
    print(f"\n[完成] {time.time() - t0:.0f}s，LLM 共 {ROUND[0]} 轮")
    print(f"双击 {os.path.join(out_dir, 'index.html')} 开玩；v2 扩展建议见 extension_report.md")


if __name__ == "__main__":
    main()
