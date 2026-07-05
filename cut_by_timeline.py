#!/usr/bin/env python3
"""
cut_by_timeline.py — 按连播面板导出的“分段表”，把整段录像切成一节一节的 mp4。

原理：分段表记录了每节“开始播放”的钟表时间。录像是连续的，所以
      第 i 节在录像里的时长 = 下一节开始时间 - 本节开始时间；
      第 i 节在录像里的起点 = 本节开始时间 - 录像开始时刻。

用法：
    python3 cut_by_timeline.py --video 录像.mkv --timeline 分段表.txt
    # 若整体有偏移，手动指定 OBS 开始录制的钟表时间：
    python3 cut_by_timeline.py --video 录像.mkv --timeline 分段表.txt --rec-start "2026/7/5 17:04:40"
    # 先看看会怎么切、不实际执行：加 --dry-run

分段表.txt：把连播面板「📋 分段表」复制出来的内容整段存成文本即可。
每行形如（tab 或多空格分隔均可）：
    1    2026/7/5 17:04:47    4-1: 【视频】课程先导片

录像开始时刻(--rec-start)：
    不填则自动取录像文件的创建时间(macOS birthtime)，通常即 OBS 开始录制的时刻。
    ⚠️ 请对“原始 mkv”运行（remux 成 mp4 会改掉创建时间）；若切出来整体偏移，就用
       --rec-start 手动指定（OBS 默认文件名往往就是开始录制的日期时间）。
"""
import argparse
import datetime
import os
import re
import subprocess
import sys
from pathlib import Path

TS_RE = re.compile(r'(\d{4})/(\d{1,2})/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})')


def parse_ts(s: str) -> datetime.datetime:
    m = TS_RE.search(s)
    if not m:
        raise ValueError(f"无法解析时间：{s!r}")
    y, mo, d, h, mi, se = map(int, m.groups())
    return datetime.datetime(y, mo, d, h, mi, se)


def sanitize(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]+', '_', name).strip()
    name = re.sub(r'\s+', ' ', name)
    return name[:80] or "lesson"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True, help="整段录像（建议原始 mkv）")
    ap.add_argument("--timeline", required=True, help="分段表文本文件")
    ap.add_argument("--rec-start", help='OBS 开始录制的钟表时间，形如 "2026/7/5 17:04:40"')
    ap.add_argument("--outdir", default="切片", help="输出目录（默认 ./切片）")
    ap.add_argument("--reencode", action="store_true", help="重新编码（更精准但慢；默认直接拷贝流，快）")
    ap.add_argument("--dry-run", action="store_true", help="只打印将执行的切法，不实际切")
    a = ap.parse_args()

    video = Path(a.video).expanduser()
    if not video.exists():
        sys.exit(f"找不到录像：{video}")

    # 解析分段表
    items = []
    for line in Path(a.timeline).expanduser().read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        m = re.match(r'^\s*(\d+)\D+(\d{4}/\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2}:\d{2})\s+(.*)$', line)
        if not m:
            continue
        items.append((int(m.group(1)), parse_ts(m.group(2)), m.group(3).strip()))
    if not items:
        sys.exit("分段表为空或格式不对")
    items.sort(key=lambda x: x[1])

    # 录像开始时刻
    if a.rec_start:
        rec_start = parse_ts(a.rec_start)
    else:
        st = os.stat(video)
        bt = getattr(st, "st_birthtime", None) or st.st_mtime
        rec_start = datetime.datetime.fromtimestamp(bt)
    print(f"录像开始时刻：{rec_start:%Y/%m/%d %H:%M:%S}（如整体偏移，用 --rec-start 覆盖）\n")

    outdir = Path(a.outdir).expanduser()
    outdir.mkdir(parents=True, exist_ok=True)

    ok = 0
    for i, (idx, ts, title) in enumerate(items):
        start = max(0.0, (ts - rec_start).total_seconds())
        dur = (items[i + 1][1] - ts).total_seconds() if i + 1 < len(items) else None
        out = outdir / f"{idx:02d}_{sanitize(title)}.mp4"

        cmd = ["ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(video)]
        if dur is not None:
            cmd += ["-t", f"{dur:.3f}"]
        if a.reencode:
            cmd += ["-c:v", "libx264", "-crf", "20", "-c:a", "aac", "-b:a", "160k"]
        else:
            cmd += ["-c", "copy", "-avoid_negative_ts", "make_zero"]
        cmd.append(str(out))

        print(f"[{idx:>2}] {start:7.1f}s  {'到片尾' if dur is None else f'{dur:6.1f}s'}  → {out.name}")
        if a.dry_run:
            continue
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if r.returncode != 0:
            print(f"     ⚠️ 失败：{r.stderr.decode(errors='ignore').splitlines()[-1] if r.stderr else ''}")
        else:
            ok += 1

    if a.dry_run:
        print(f"\n（dry-run 预览：共 {len(items)} 节，未实际切。去掉 --dry-run 即开始切）")
        return
    print(f"\n完成：{ok}/{len(items)} 节 → {outdir}")
    if ok == 0:
        print("提示：若全部失败，多半是编码不兼容 mp4 直拷，改用 --reencode 再跑一次。")


if __name__ == "__main__":
    main()
