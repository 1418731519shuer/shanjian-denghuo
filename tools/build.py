# -*- coding: utf-8 -*-
"""构建发布产物：图片转 WebP、排除 .raw.png、改写 index.html 引用、复制 PWA 文件。
用法: python tools/build.py   产物输出到 dist/
"""
import os, re, shutil, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_ASSETS = os.path.join(ROOT, 'assets')
DIST = os.path.join(ROOT, 'dist')

# 目录: (最长边, 质量)
RULES = {'bg': (1920, 80), 'cg': (1920, 85), 'chars': (1024, 85)}

# 原样拷贝的目录（音频等不做转换）
COPY_DIRS = ('bgm', 'sfx')

def copy_plain(subdir):
    """音频等非图片目录原样拷贝到 dist/assets/。"""
    src_dir = os.path.join(SRC_ASSETS, subdir)
    if not os.path.isdir(src_dir):
        print('%-6s (不存在，跳过)' % subdir)
        return
    dst_dir = os.path.join(DIST, 'assets', subdir)
    shutil.copytree(src_dir, dst_dir)
    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(dst_dir) for f in fs)
    print('%-6s %6.1fMB (原样拷贝)' % (subdir, total / 1e6))

def convert(subdir, max_side, quality):
    src_dir = os.path.join(SRC_ASSETS, subdir)
    dst_dir = os.path.join(DIST, 'assets', subdir)
    os.makedirs(dst_dir, exist_ok=True)
    total_in = total_out = 0
    for fn in sorted(os.listdir(src_dir)):
        if fn.endswith('.raw.png') or not fn.lower().endswith(('.png', '.jpg', '.jpeg')):
            continue
        src = os.path.join(src_dir, fn)
        out = os.path.join(dst_dir, os.path.splitext(fn)[0] + '.webp')
        img = Image.open(src)
        has_alpha = img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info)
        img = img.convert('RGBA' if has_alpha else 'RGB')
        if max(img.size) > max_side:
            r = max_side / max(img.size)
            img = img.resize((max(1, round(img.width * r)), max(1, round(img.height * r))), Image.LANCZOS)
        img.save(out, 'WEBP', quality=quality, method=6)
        total_in += os.path.getsize(src); total_out += os.path.getsize(out)
    print('%-6s %6.1fMB -> %5.1fMB' % (subdir, total_in / 1e6, total_out / 1e6))

def main():
    if os.path.exists(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)

    for sub, (side, q) in RULES.items():
        convert(sub, side, q)

    for sub in COPY_DIRS:
        copy_plain(sub)

    # manifest.json 一并更新（记录用，不影响运行）
    man_src = os.path.join(SRC_ASSETS, 'manifest.json')
    if os.path.exists(man_src):
        txt = open(man_src, encoding='utf-8').read()
        txt = re.sub(r'\.(png|jpg|jpeg)"', '.webp"', txt)
        txt = txt.replace('.raw.webp', '.raw.png')  # raw 不发布，路径留原样
        open(os.path.join(DIST, 'assets', 'manifest.json'), 'w', encoding='utf-8').write(txt)

    # index.html: 资源引用改 .webp
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    # 引用形式为 "chars/xx.png" / "bg/xx.jpg"（assets_dir 前缀由引擎拼接）
    html = re.sub(r"((?:bg|cg|chars)/[^'\"()\\]+?)\.(?:png|jpg|jpeg)", r'\1.webp', html)
    open(os.path.join(DIST, 'index.html'), 'w', encoding='utf-8').write(html)

    # AI 生成模块（网页端剧本生成，独立 JS；图片扩展名由它运行时自动探测，无需改写）
    ai_gen = os.path.join(ROOT, 'ai_gen.js')
    if os.path.exists(ai_gen):
        shutil.copy(ai_gen, DIST)

    # 文字脚本编译器（浏览器版 tsc，独立 JS，零依赖）
    tsc_js = os.path.join(ROOT, 'tsc.js')
    if os.path.exists(tsc_js):
        shutil.copy(tsc_js, DIST)

    # PWA 静态文件
    shutil.copy(os.path.join(ROOT, 'manifest.webmanifest'), DIST)
    make_icons()
    make_sw()

    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(DIST) for f in fs)
    print('dist total: %.1fMB' % (total / 1e6))

def make_icons():
    """用背景图中心裁切生成应用图标。"""
    src = os.path.join(SRC_ASSETS, 'bg', 'lantern_shop.jpg')
    img = Image.open(src).convert('RGB')
    s = min(img.size)
    img = img.crop(((img.width - s) // 2, (img.height - s) // 2,
                    (img.width + s) // 2, (img.height + s) // 2))
    out_dir = os.path.join(DIST, 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size, name in ((192, 'icon-192.png'), (512, 'icon-512.png'), (512, 'icon-512-maskable.png')):
        img.resize((size, size), Image.LANCZOS).save(os.path.join(out_dir, name))

SW_TEMPLATE = u"""// 自动生成，请勿手改 —— python tools/build.py
const CACHE = 'wenyou-{version}';
const ASSETS = {files};
self.addEventListener('install', e => {{
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
}});
self.addEventListener('activate', e => {{
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
}});
self.addEventListener('fetch', e => {{
  if (e.request.method !== 'GET') return;
  /* 导航请求（index.html）：网络优先、失败回退缓存 —— 保证新版本能及时生效 */
  if (e.request.mode === 'navigate') {{
    e.respondWith(fetch(e.request).then(resp => {{
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return resp;
    }}).catch(() => caches.match(e.request, {{ ignoreSearch: true }})
      .then(r => r || caches.match('./index.html'))));
    return;
  }}
  /* 静态资源：缓存优先，回源后写入缓存 */
  e.respondWith(caches.match(e.request, {{ ignoreSearch: true }}).then(r => r ||
    fetch(e.request).then(resp => {{
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return resp;
    }})));
}});
"""

def make_sw():
    import json, time
    files = ['./', './index.html', './manifest.webmanifest',
             './icons/icon-192.png', './icons/icon-512.png']
    # ai_gen.js / tsc.js 存在时一并纳入预缓存（离线可用）
    for js in ('ai_gen.js', 'tsc.js'):
        if os.path.exists(os.path.join(DIST, js)):
            files.append('./' + js)
    for dp, _, fs in os.walk(os.path.join(DIST, 'assets')):
        for f in sorted(fs):
            rel = os.path.relpath(os.path.join(dp, f), DIST).replace(os.sep, '/')
            files.append('./' + rel)
    sw = SW_TEMPLATE.format(version=int(time.time()), files=json.dumps(files, indent=2))
    open(os.path.join(DIST, 'sw.js'), 'w', encoding='utf-8').write(sw)

if __name__ == '__main__':
    main()
