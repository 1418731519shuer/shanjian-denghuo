# -*- coding: utf-8 -*-
"""临时工具：按清单从 DOVA-SYNDROME 详情页解析音频直链并下载原始文件。
用法: python tools/_download_dova.py <输出目录>
清单内嵌于本文件 PICKS（本地文件名 <- DOVA-S 详情页ID）。
"""
import re, sys, os, io, json, time, urllib.request

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
R2 = 'https://pub-23d1ec6d588446bb9381dac03f148027.r2.dev'

# (本地文件名, 类型, DOVA-S详情页ID, 备注)
PICKS = [
    # ---- BGM（剧本引用 6 首 + 备用 2 首）----
    ('rain_night.mp3',   'bgm', '23702', 'やさしい雨 / マニーラ —— 雨夜渡口·忧伤'),
    ('teashelter.mp3',   'bgm', '23612', '優しくなれたら / 蒲鉾さちこ —— 茶棚温情'),
    ('shop_warm.mp3',    'bgm', '23712', '色恋沙汰に縁なし男 / VeryGoodMan —— 灯笼铺日常'),
    ('town_day.mp3',     'bgm', '23045', '和の街並み / マニーラ —— 小镇白天'),
    ('bamboo_wind.mp3',  'bgm', '23701', '静かな竹林 / マニーラ —— 竹林清冷'),
    ('festival.mp3',     'bgm', '23469', '七夕の香 / Sound Of Incense —— 灯会夜晚'),
    ('tense.mp3',        'bgm', '23222', '龍太鼓 / 伊藤ケイスケ —— 紧张(备用)'),
    ('ending.mp3',       'bgm', '23631', '花束 / のる —— 结局感动(备用)'),
    # ---- SFX（剧本引用 7 个 + 备用 4 个）----
    ('rain_loop.wav',     'se', '1122', '雨音とちょっと風の音 / NaruIDEA'),
    ('rain_on_roof.wav',  'se', '1232', '軒下の雨音 / Notzan ACT'),
    ('boat_creak.wav',    'se', '1214', '古い洋館のドアが軋む音 / NaruIDEA'),
    ('market_noise.wav',  'se', '1158', '出店屋台の通り / 稿屋隆'),
    ('sword_whoosh.wav',  'se', '1422', '風切り音（軽）/ 稿屋隆'),
    ('bamboo_rustle.wav', 'se', '1152', '草むらガサゴソ / 稿屋隆'),
    ('crowd_cheer.wav',   'se', '785',  '花火大会の音 / Causality Sound'),
    ('footsteps.wav',     'se', '1428', '砂利砂 / 稿屋隆'),
    ('door.wav',          'se', '1215', '古い洋館のドアを閉める音 / NaruIDEA'),
    ('paper.wav',         'se', '1191', '紙のページをめくる音 / Notzan ACT'),
    ('wind_chime.wav',    'se', '1293', '風鈴 / えすにっく・かわひろ'),
]

def fetch(url, binary=False):
    req = urllib.request.Request(url, headers=UA)
    data = urllib.request.urlopen(req, timeout=120).read()
    return data if binary else data.decode('utf-8', 'replace')

def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    credits = []
    for fname, kind, tid, note in PICKS:
        path = os.path.join(out_dir, fname)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            print(f'SKIP {fname:20s} (已存在)')
            continue
        page_url = f'https://dova-s.jp/{kind}/detail/{tid}'
        try:
            html = fetch(page_url)
            # 详情页内音频文件 uuid（可能多轨，取第 1 轨）
            uuids = re.findall(r'filepath=' + kind + r'%2Faudio%2F([0-9a-f-]+\.mp3)', html)
            if not uuids:
                uuids = re.findall(r'/' + kind + r'/audio/([0-9a-f-]+\.mp3)', html)
            if not uuids:
                raise RuntimeError('no audio uuid found')
            title = re.search(r"<title>[^『]*『(.*?)』", html)
            author = re.search(r'/creator/detail/\d+">([^<]+)</a>', html)
            src = f'{R2}/{kind}/audio/{uuids[0]}'
            raw = fetch(src, binary=True)
            path = os.path.join(out_dir, fname)
            with open(path, 'wb') as f:
                f.write(raw)
            credits.append({'file': fname, 'kind': kind, 'id': tid,
                            'title': title.group(1) if title else '',
                            'author': author.group(1) if author else '',
                            'page_url': page_url, 'note': note,
                            'bytes': len(raw)})
            print(f'OK  {fname:20s} {len(raw)/1e6:6.2f}MB  {note}')
        except Exception as e:
            print(f'FAIL {fname:20s} {e}')
        time.sleep(0.5)
    # 合并已有 credits（断点续跑时不丢前次记录）
    credits_path = os.path.join(out_dir, '_credits.json')
    merged = {c['file']: c for c in credits}
    if os.path.exists(credits_path):
        for c in json.load(io.open(credits_path, encoding='utf-8')):
            merged.setdefault(c['file'], c)
    with io.open(credits_path, 'w', encoding='utf-8') as f:
        json.dump(list(merged.values()), f, ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main()
