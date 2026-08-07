#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_text_demo.py —— 文字脚本实战示例的游戏变体构建

把 tsc.py 编译出的 scripts/demo_branch.json 嵌入引擎，产出两份产物：
  ① demo_gl/index_text_demo.html   —— 开发变体（引用 assets/ 原始 png/jpg，双击即玩）
  ② demo_gl/dist_text/             —— 发布变体：复制 dist/ 全部内容，
       仅替换 index.html 里的 EMBEDDED_SCRIPT（引用改 .webp、</ 转义）与 <title>

用法（从 demo_gl 运行）：
  python tools/build_text_demo.py
前置：先跑过 python tools/tsc.py scripts/demo_branch.txt 与 python tools/build.py
"""
import json
import os
import re
import shutil
import sys

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS_DIR)                 # demo_gl/
SRC_HTML = os.path.join(ROOT, 'index.html')
SCRIPT_JSON = os.path.join(ROOT, 'scripts', 'demo_branch.json')
DIST = os.path.join(ROOT, 'dist')
DIST_TEXT = os.path.join(ROOT, 'dist_text')
OUT_HTML = os.path.join(ROOT, 'index_text_demo.html')

WEBP_RE = re.compile(r"((?:bg|cg|chars)/[^'\"()\\]+?)\.(?:png|jpg|jpeg)")


def embed(html, script, webp):
    """替换 EMBEDDED_SCRIPT 赋值行与 <title>（做法同 tools/autonovel.py render_html）。"""
    payload = json.dumps(script, ensure_ascii=False)
    payload = payload.replace('</', '<\\/')        # 防剧本文本里的 </script> 截断 HTML
    if webp:
        payload = WEBP_RE.sub(r'\1.webp', payload)
    html, cnt = re.subn(r'^const EMBEDDED_SCRIPT = .*;$',
                        'const EMBEDDED_SCRIPT = ' + payload + ';',
                        html, count=1, flags=re.M)
    if cnt != 1:
        raise RuntimeError('index.html 中未找到唯一的 EMBEDDED_SCRIPT 赋值行')
    title = re.escape(str(script.get('meta', {}).get('title', '')))
    html = re.sub(r'<title>.*?</title>', '<title>' + title + '</title>', html, count=1)
    return html


def main():
    if not os.path.exists(SCRIPT_JSON):
        sys.exit('[错误] 缺少 scripts/demo_branch.json，先跑：python tools/tsc.py scripts/demo_branch.txt')
    if not os.path.exists(os.path.join(DIST, 'index.html')):
        sys.exit('[错误] 缺少 dist/index.html，先跑：python tools/build.py')
    with open(SCRIPT_JSON, encoding='utf-8') as f:
        script = json.load(f)

    # ① 开发变体：基于源 index.html（引用原始 png/jpg，配 demo_gl/assets 使用）
    with open(SRC_HTML, encoding='utf-8') as f:
        html = f.read()
    with open(OUT_HTML, 'w', encoding='utf-8') as f:
        f.write(embed(html, script, webp=False))
    print(f'[完成] 开发变体 → {OUT_HTML}')

    # ② 发布变体：复制 dist/，仅替换 index.html（dist 里素材已是 .webp）
    if os.path.exists(DIST_TEXT):
        shutil.rmtree(DIST_TEXT)
    shutil.copytree(DIST, DIST_TEXT)
    with open(os.path.join(DIST, 'index.html'), encoding='utf-8') as f:
        dist_html = f.read()
    with open(os.path.join(DIST_TEXT, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(embed(dist_html, script, webp=True))
    total = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fs in os.walk(DIST_TEXT) for fn in fs)
    print(f'[完成] 发布变体 → {DIST_TEXT}（{total / 1e6:.1f}MB，复制自 dist/ 并替换 EMBEDDED_SCRIPT）')


if __name__ == '__main__':
    main()
