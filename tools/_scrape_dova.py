# -*- coding: utf-8 -*-
"""临时工具：抓取 DOVA-SYNDROME 列表页，输出曲目清单（id/标题/作者/描述/DL数）。
用法: python tools/_scrape_dova.py <bgm|se> "<URL模板,{page}为页码>" <起始页> <结束页> <输出文件>
"""
import re, sys, io, json, time, urllib.request

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}

def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')

def main():
    kind, tpl, p1, p2, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    items = {}
    for page in range(p1, p2 + 1):
        url = tpl.format(page=page)
        try:
            html = fetch(url)
        except Exception as e:
            print(f'page {page} fetch fail: {e}', file=sys.stderr)
            continue
        # 每个曲目块: detail链接 + 标题 + 作者 + 描述（BGM 有 icotime，SE 有 icodl）
        for m in re.finditer(
            r'<div class="bgmlist-tracktitle">'
            r'<a href="/' + kind + r'/detail/(\d+)">(.*?)</a>'
            r'(?:<span>by<a href="/creator/detail/\d+">(.*?)</a></span>)?.*?'
            r'<div class="bgmlist-trackdetail">(.*?)</div>'
            r'(.*?)</div></div></div>',
            html, re.S):
            tid, title, author, desc, tail = m.groups()
            clean = lambda s: re.sub(r'<[^>]+>|\s+', ' ', s).strip()
            dur = re.search(r'icotime">\s*([\d:]+)', tail)
            dl = re.search(r'icodl">\s*(\d+)', tail)
            items[tid] = {
                'id': tid, 'title': clean(title), 'author': clean(author or ''),
                'duration': dur.group(1) if dur else '', 'dl': dl.group(1) if dl else '',
                'desc': clean(desc),
                'page_url': f'https://dova-s.jp/{kind}/detail/{tid}',
            }
        time.sleep(0.5)
    with io.open(out, 'w', encoding='utf-8') as f:
        for it in items.values():
            f.write(json.dumps(it, ensure_ascii=False) + '\n')
    print(f'{len(items)} items -> {out}')

if __name__ == '__main__':
    main()
