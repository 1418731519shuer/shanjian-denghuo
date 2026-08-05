# -*- coding: utf-8 -*-
"""临时工具：把下载的原始音频压缩到 ≤500KB（44.1kHz MP3），输出到 assets/bgm、assets/sfx。
BGM 超时长的截到 120s 并加淡出；SFX 超 90s 截断加淡出。文件名沿用剧本引用（.wav 实为 MP3 内容，浏览器按内容嗅探解码）。
用法: python tools/_compress_audio.py <原始目录>
"""
import os, sys, json, subprocess, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUDGET = 500 * 1024          # 500KB
CBR_STEPS = [24, 32, 40, 48, 56, 64, 80]  # kbps，从小到大尝试上限内最大

def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'default=nw=1:nk=1', path],
                         capture_output=True, text=True).stdout.strip()
    return float(out)

def pick_bitrate(dur):
    """按时长选能塞进 500KB 的最大 CBR 码率（留 5% 余量）。"""
    for kb in reversed(CBR_STEPS):
        if kb * 1000 / 8 * dur * 1.05 <= BUDGET:
            return kb
    return CBR_STEPS[0]

def convert(src, dst, max_dur):
    dur = probe(src)
    use_dur = min(dur, max_dur)
    kb = pick_bitrate(use_dur)
    args = ['ffmpeg', '-y', '-v', 'error', '-i', src]
    if dur > max_dur:
        # 截断并在结尾 3 秒淡出，避免硬切
        args += ['-t', str(max_dur),
                 '-af', f'afade=t=out:st={max_dur - 3}:d=3']
    args += ['-vn', '-map_metadata', '-1',  # 去掉封面图/元数据，避免体积超标
             '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', f'{kb}k', dst]
    subprocess.run(args, check=True)
    size = os.path.getsize(dst)
    status = 'OK' if size <= BUDGET else 'OVER'
    print(f'{status} {os.path.basename(dst):20s} {dur:6.1f}s -> {use_dur:6.1f}s  {kb}kbps  {size/1024:6.1f}KB')
    return size <= BUDGET

def main():
    raw_dir = sys.argv[1]
    bgm_dir = os.path.join(ROOT, 'assets', 'bgm')
    sfx_dir = os.path.join(ROOT, 'assets', 'sfx')
    os.makedirs(bgm_dir, exist_ok=True)
    os.makedirs(sfx_dir, exist_ok=True)
    all_ok = True
    for fn in sorted(os.listdir(raw_dir)):
        src = os.path.join(raw_dir, fn)
        if fn.startswith('_') or not os.path.isfile(src):
            continue
        if fn.endswith('.mp3'):
            all_ok &= convert(src, os.path.join(bgm_dir, fn), 120)
        elif fn.endswith('.wav'):
            all_ok &= convert(src, os.path.join(sfx_dir, fn), 90)
    print('ALL OK' if all_ok else 'SOME FILE OVER 500KB!')

if __name__ == '__main__':
    main()
