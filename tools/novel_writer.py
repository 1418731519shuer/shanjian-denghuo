#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""长篇写作器（NovelWriter）—— 移植 InkOS 长篇方法论，step-explore 驱动，产出 ≥5 万字小说。

方法来源（InkOS inkos-long-writing skill + references，规则全文内置于 CRAFT）：
  场景四要素（目标/阻力/转折/后果）、多轴推进、对话承压、信息克制释放、
  章末落在实质变化、最小层修复、篇幅=场景预算。

用法（demo_gl 目录下）：
  python tools/novel_writer.py --theme "仙侠" --chapters 20        # 全流程
  python tools/novel_writer.py --resume                            # 断点续写
产物：novels/<书名>/book.json + chapters/ch001.md… + 全文.md
"""
import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from novel_forge import chat_explore, chat_json  # noqa: E402  复用 step-explore 客户端与重试

CRAFT = """写作铁律（必须逐条遵守）：
1. 每章由 2-5 个场景组成，每个场景有： immediate 目标、阻力、实质性转折、能带出场景的后果。篇幅按场景的戏剧工作量分配，绝不注水。
2. 人物的每个选择都要符合她想要什么、知道什么、怕什么、付得起什么。关系的变化通过事件呈现，禁止作者旁白解释"她们关系变好了"。
3. 设定与往事通过动作、证据、对话、感官细节释放；禁用大段设定倾倒和剧情概要代替场景。
4. 每一段都必须改变以下至少一项：冲突、证据、情感、关系、信息、处境、后续后果。没用的段落直接删。
5. 对话要有压力：每次有意义的回话都要改变博弈、暴露软肋、制造亏欠或逼迫选择；删掉只是复述立场的对话。潜台词来自"说出来要冒的风险"。
6. 章末落在实质变化或新压力上，不用机械悬念公式。大高潮之后先写余波再开启下一轮升级。
7. 读者契约：开篇承诺的爽点类型（本作为主仆相认/双强拉扯/身份错位），每章都要用具体事件投喂，不是口头提及。
8. 禁止 AI 味：不用"仿佛/宛如/不禁/嘴角勾起一抹"高频套话；不用"她知道，从这一刻起"式总结腔；比喻要新。
9. 因果自主：压力靠人物选择在约束下产生，不用巧合、不降智反派。新信息改变路线时，写出它如何被发现、为何此时重要。"""

SYS = "你是顶级中文网文作家，擅长仙侠群像与细腻情感线（女主视角，CP 好磕）。" + CRAFT


# ---------------------------------------------------------------- 阶段
def stage_bible(theme, n_chars):
    """① story_bible：书名/世界观/角色卡（含 CP 张力网）/爽点契约。"""
    print("[1/4] story_bible …")
    return chat_json(
        f"题材：{theme}（女主视角修仙群像文，要有代入感、CP 好磕）。\n"
        f"请设计 story bible：书名要雅；角色 {n_chars}+ 人，全女，每人出身/动机/秘密不同；"
        f"明确 CP 关系网——谁和女主有张力（双强/救赎/宿敌变情人/师徒/青梅），张力来源是什么，"
        f"误会或债务是什么；女主有人格魅力不恋爱脑。\n"
        '输出：{"title":"…","worldview":"…(300字)","contract":"爽点契约(100字)",'
        '"protagonist":{"name":"…","identity":"…","charm":"魅力点(50字)"},'
        '"characters":[{"id":"c1","name":"…","role":"…","look":"…","background":"…","secret":"…",'
        '"cp_dynamic":"与女主的张力关系(30字)","arc":"她的弧线(30字)"}],'
        '"main_plot":"主线冲突(150字)","foreshadows":["伏笔1","伏笔2","伏笔3"]}',
        system=SYS)


def stage_outline(bible, n_chapters):
    """② 分章大纲：每章 目标/阻力/转折/后果。分两段生成防超长截断。"""
    print("[2/4] 分章大纲（两段）…")

    def gen(lo, hi):
        return chat_json(
            f"书名《{bible['title']}》。设定：{json.dumps(bible, ensure_ascii=False)}\n"
            f"这是一部 {n_chapters} 章长篇的章纲，你只负责第 {lo} 到 {hi} 章。"
            f"主线冲突按 起/承/转/合 推进；CP 线每 2-3 章一次实质进展；伏笔分阶段回收；每章四要素齐全。\n"
            '输出：{"chapters":[{"no":' + str(lo) + ',"title":"…","goal":"本章目标","resistance":"阻力",'
            '"turn":"转折","consequence":"后果","cp_beat":"CP进展点(可空)","chars":["c1"]}]}，'
            f"章号从 {lo} 到 {hi}，每个字段不超过 40 字。",
            system=SYS)

    half = (n_chapters + 1) // 2
    a = gen(1, half)
    b = gen(half + 1, n_chapters)
    return {"chapters": a.get("chapters", []) + b.get("chapters", [])}


CHAPTER_RULES = (
    "本章 2500-3000 字正文（不含标题）。直接输出正文，不要任何解释、不要 markdown 标题、不要分节号。"
    "开篇第一句就要在具体场景里（谁在何处做什么），禁止\"时光荏苒\"式开场。"
)


def write_chapter(bible, outline_ch, prev_summary, style_guide=""):
    """写一章。prev_summary 为前文摘要（控制上下文长度）。"""
    prompt = (
        f"书名《{bible['title']}》。\n设定：{json.dumps({k: bible[k] for k in ('worldview', 'protagonist', 'characters', 'main_plot', 'foreshadows')}, ensure_ascii=False)}\n"
        f"前文摘要：{prev_summary or '（这是第一章）'}\n"
        f"本章大纲：第{outline_ch['no']}章《{outline_ch['title']}》\n"
        f"目标：{outline_ch['goal']}；阻力：{outline_ch['resistance']}；转折：{outline_ch['turn']}；后果：{outline_ch['consequence']}；"
        f"CP 节拍：{outline_ch.get('cp_beat') or '无硬性要求'}。\n"
        + CHAPTER_RULES)
    return chat_explore(prompt, system=SYS, max_tokens=8192)


def summarize_chapter(text):
    """章节摘要（供后续章节续接，1 轮轻调用）。"""
    return chat_explore(
        "把下面这一章压缩成 120 字内的剧情摘要（只记：发生了什么、谁的关系/处境怎么变了、留了什么钩子）：\n" + text[:6000],
        system="你是编辑，只输出摘要。", max_tokens=512)


def audit_chapter(bible, ch, text):
    """轻审计：人设/伏笔/节奏。返回问题清单（空=通过）。"""
    rep = chat_explore(
        f"审稿。设定：{json.dumps({'characters': bible['characters'], 'foreshadows': bible['foreshadows']}, ensure_ascii=False)}\n"
        f"第{ch['no']}章大纲：{json.dumps(ch, ensure_ascii=False)}\n正文：\n{text[:6000]}\n"
        "只检查三条：①人物言行是否违背人设卡；②大纲四要素是否都落实；③是否有明显 AI 味套话。"
        "没有问题只输出「通过」；有问题逐条列出（每条一行，指明位置和改法）。",
        system="你是严苛的网文审稿编辑。", max_tokens=1024)
    return [] if rep.strip().startswith('通过') else [rep]


def revise_chapter(bible, ch, text, issues):
    """最小层修复：只改有问题的部分。"""
    return chat_explore(
        f"这一章正文有问题需要局部修复（保持整体结构和字数，只改问题点）：\n问题：{issues}\n"
        f"正文：\n{text}\n" + CHAPTER_RULES + "\n输出修复后的完整正文。",
        system=SYS, max_tokens=8192)


# ---------------------------------------------------------------- 主流程
def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8')
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument('--theme', default='仙侠问道')
    ap.add_argument('--chapters', type=int, default=20)
    ap.add_argument('--chars', type=int, default=10)
    ap.add_argument('--min-chars', type=int, default=50000, help='全文字数下限')
    ap.add_argument('--workers', type=int, default=3)
    ap.add_argument('--resume', default=None, help='续写：书名目录名（复用 book.json/outline.json，只补缺失章节）')
    args = ap.parse_args()

    # 断点：先跑 bible+outline 确定书名目录
    root = os.path.join(os.path.dirname(HERE), 'novels')
    os.makedirs(root, exist_ok=True)

    t0 = time.time()
    # 续写模式：显式指定书名目录则复用其设定与章纲
    if args.resume:
        book_dir = os.path.join(root, args.resume)
        bible = json.load(open(os.path.join(book_dir, 'book.json'), encoding='utf-8'))
        outline = json.load(open(os.path.join(book_dir, 'outline.json'), encoding='utf-8'))
        title = bible['title']
        chapters = outline['chapters']
        print(f"  [续写] 复用《{title}》设定与章纲（{len(chapters)} 章）")
    else:
        bible = stage_bible(args.theme, args.chars)
        title = bible['title'].strip('《》')
        book_dir = os.path.join(root, title)
        ch_dir = os.path.join(book_dir, 'chapters')
        os.makedirs(ch_dir, exist_ok=True)
        json.dump(bible, open(os.path.join(book_dir, 'book.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f"  书名《{title}》，角色 {len(bible['characters'])} 人")

        outline = stage_outline(bible, args.chapters)
        chapters = outline['chapters']
        json.dump(outline, open(os.path.join(book_dir, 'outline.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f"  章纲 {len(chapters)} 章")
    ch_dir = os.path.join(book_dir, 'chapters')
    os.makedirs(ch_dir, exist_ok=True)

    # ③ 逐章写作（断点：chapters/chNNN.md 存在即跳过；并发 3 路）
    print(f"[3/4] 逐章写作（并发 {args.workers}，每章落盘即存）…")
    summaries = {}
    sum_path = os.path.join(book_dir, 'summaries.json')
    if os.path.exists(sum_path):
        summaries = json.load(open(sum_path, encoding='utf-8'))

    def do_chapter(ch):
        no = ch['no']
        fp = os.path.join(ch_dir, f'ch{no:03d}.md')
        if os.path.exists(fp) and os.path.getsize(fp) > 1500:
            return no, 'cached'
        prev_summary = '；'.join(summaries.get(str(k), '') for k in range(max(1, no - 3), no)) or ''
        text = write_chapter(bible, ch, prev_summary)
        issues = audit_chapter(bible, ch, text)
        if issues:
            print(f"  第{no}章审计发现问题，局部修复")
            fixed = revise_chapter(bible, ch, text, issues)
            if len(fixed) >= 800:   # 修复稿异常（空/过短）时保留原稿
                text = fixed
            else:
                print(f"  第{no}章修复稿过短（{len(fixed)}字），保留原稿")
        open(fp, 'w', encoding='utf-8').write(f"# 第{ch['no']}章 {ch['title']}\n\n" + text)
        summaries[str(no)] = summarize_chapter(text)
        json.dump(summaries, open(sum_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f"  第{no}章完成（{len(text)}字）")
        return no, 'done'

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(do_chapter, chapters))

    # ④ 合并 + 字数补足
    print("[4/4] 合并校对 …")
    total = 0
    parts = []
    for ch in chapters:
        fp = os.path.join(ch_dir, f"ch{ch['no']:03d}.md")
        if os.path.exists(fp):
            t = open(fp, encoding='utf-8').read()
            parts.append(t)
            total += len(re.sub(r'\s', '', t))
    print(f"  全文字数：{total}")
    # 字数不足自动补番外章
    extra_no = len(chapters)
    while total < args.min_chars and extra_no < args.chapters + 6:
        extra_no += 1
        ch = {'no': extra_no, 'title': f'番外·{extra_no - len(chapters)}',
              'goal': '补充主线之后的角色日常/情感余波', 'resistance': '无强冲突，写人物关系沉淀',
              'turn': '一个温暖或幽默的小转折', 'consequence': '收束余韵', 'cp_beat': '补一颗糖',
              'chars': [c['id'] for c in bible['characters'][:3]]}
        prev_summary = '；'.join(list(summaries.values())[-3:])
        text = write_chapter(bible, ch, prev_summary)
        fp = os.path.join(ch_dir, f'ch{extra_no:03d}.md')
        open(fp, 'w', encoding='utf-8').write(f"# 第{extra_no}章 {ch['title']}\n\n" + text)
        parts.append(open(fp, encoding='utf-8').read())
        total += len(re.sub(r'\s', '', text))
        print(f"  补写番外第{extra_no}章（累计 {total} 字）")

    full = f"# 《{title}》\n\n" + '\n\n'.join(parts)
    open(os.path.join(book_dir, '全文.md'), 'w', encoding='utf-8').write(full)
    print(f"\n[完成] 《{title}》 {total} 字，{time.time() - t0:.0f}s")
    print(f"目录：{book_dir}（全文.md 可直接阅读）")


if __name__ == '__main__':
    main()
