#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小说 → 文游转换器：把 novel_writer 产出的小说转成可玩的文游变体（PWA）。

原理：
  每章 → 一个场景；正文按段切成 narrate；含角色对话（"…"/「…」且前文附近有角色名）的段落
  拆成 say + narrate；背景/立绘走 autonovel.remap_assets 复用现有素材库；
  最后一章挂 end 指令（进结局收集）。

用法（demo_gl 目录下）：
  python tools/novel_to_game.py "novels/剑魄簪光"            # 产出 games/<slug>/
  然后 python tools/build.py 会自动把它打包成 PWA 子应用（dist/games/<slug>/）
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import autonovel  # noqa: E402


def split_paragraphs(text):
    paras = [p.strip() for p in re.split(r'\n\s*\n|\n', text) if p.strip()]
    return paras


def chunk_narrate(text, maxlen=90):
    """长段按句号/问号/叹号切成 ≤maxlen 的 narrate 块。"""
    parts = re.split(r'(?<=[。！？…])', text)
    out, cur = [], ''
    for p in parts:
        if len(cur) + len(p) <= maxlen:
            cur += p
        else:
            if cur:
                out.append(cur)
            cur = p
    if cur:
        out.append(cur)
    return [o for o in out if o.strip()]


DIALOG_RE = re.compile(r'["「](.*?)["」]')


def para_to_cmds(para, names):
    """段落 → 指令列表。含引语且能找到说话人 → say + 剩余 narrate。"""
    m = DIALOG_RE.search(para)
    if not m:
        return [{'type': 'narrate', 'text': c} for c in chunk_narrate(para)]
    # 找说话人：引语前 20 字内的角色名
    before = para[:m.start()][-20:]
    who = None
    for cid, name in names.items():
        if name and name in before:
            who = cid
            break
    if not who:
        return [{'type': 'narrate', 'text': c} for c in chunk_narrate(para)]
    cmds = []
    said = m.group(1)
    rest = (para[:m.start()] + para[m.end():]).strip('，。：: ')
    cmds.append({'type': 'say', 'who': who, 'text': said})
    if rest and len(rest) > 4:
        cmds.extend({'type': 'narrate', 'text': c} for c in chunk_narrate(rest))
    return cmds


def convert(book_dir, out_slug=None):
    book = json.load(open(os.path.join(book_dir, 'book.json'), encoding='utf-8'))
    title = book['title']
    ch_dir = os.path.join(book_dir, 'chapters')
    ch_files = sorted(f for f in os.listdir(ch_dir) if f.startswith('ch') and f.endswith('.md'))
    if not ch_files:
        sys.exit('没有章节文件')

    chars = book['characters']
    names = {c['id']: c['name'] for c in chars}
    characters = {}
    for c in chars:
        characters[c['id']] = {
            'name': c['name'], 'color': '#FFD9A0' if c['id'] == 'c1' else '#9FC0FF',
            'look': c.get('look', ''),
            'sprites': {e: f"chars/{c['id']}_{e}.png" for e in ('normal', 'smile', 'sad')},
        }

    scenes = []
    for i, f in enumerate(ch_files):
        text = open(os.path.join(ch_dir, f), encoding='utf-8').read()
        text = re.sub(r'^#.*\n', '', text).strip()   # 去标题行
        no = i + 1
        script = []
        for para in split_paragraphs(text):
            script.extend(para_to_cmds(para, names))
        # 出场角色：本章提及名字的角色（前 3 个站位）
        mentioned = [cid for cid, nm in names.items() if nm and nm in text]
        scene_chars = [{'id': cid, 'pos': p, 'sprite': 'normal'}
                       for cid, p in zip(mentioned[:3], ('left', 'center', 'right'))]
        is_last = i == len(ch_files) - 1
        if is_last:
            script.append({'type': 'end', 'label': '结局·全书完'})
        else:
            script.append({'type': 'goto', 'target': f'ch{no + 1:03d}'})
        scenes.append({
            'id': f'ch{no:03d}', 'background': 'bg/lantern_shop.jpg',  # 先占位，remap 按氛围重映射
            'checkpoint': True, 'chars': scene_chars, 'script': script,
        })

    script = {
        'meta': {'title': title, 'author': 'novel_writer + novel_to_game', 'version': '1.0',
                 'defaults': {'text_speed': 25, 'bgm_volume': 0.5, 'auto_delay': 1800}},
        'characters': characters, 'assets_dir': 'assets/', 'scenes': scenes,
    }

    # 素材复用映射（背景按每章文本氛围、立绘按序轮转库角色）
    pool = autonovel.scan_assets()
    autonovel.remap_assets(script, pool)

    slug = out_slug or ('novel_' + re.sub(r'[^a-z0-9]', '', ''))
    slug = out_slug or 'novelbook'
    out_dir = os.path.join(autonovel.DEMO_ROOT, 'games', slug)
    n_img, n_audio, missing = autonovel.build_game(script, out_dir, autonovel.SRC_ASSETS)
    print(f'[完成]《{title}》→ games/{slug}/（{len(scenes)} 章场景，{n_img} 图，缺 {len(missing)}）')
    print('跑 python tools/build.py 后部署，地址 games/' + slug + '/')
    return out_dir


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8')
        except Exception:
            pass
    book_dir = sys.argv[1]
    slug = sys.argv[2] if len(sys.argv) > 2 else None
    convert(book_dir, slug)


if __name__ == '__main__':
    main()
