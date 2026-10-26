"""功能快照的三方合并：把「上游新版源码」与「本服功能快照」合成一份可部署的源码。

用法（在仓库工作区 repo-sync 下）：
    python patcher\\merge-features.py --upstream D:\\path\\to\\upstream-master

输出：<仓库>/staging/features-merged/  （合成结果）+ report.json（逐文件状态）

路径全部从本文件位置推导，不再硬编码 D:\\Stronghold-Protocol。
以前 ROOT 写死，而仓库在 repo-sync，直接跑会找不到快照。
"""
import argparse
import json
import os
import shutil
import sys

try:
    from merge3 import Merge3
except ImportError:
    sys.exit('缺少 merge3 模块：pip install merge3')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get('SP_REPO') or os.path.dirname(HERE)
SNAP = os.path.join(REPO, 'patcher', 'features')

# 这些状态表示「文件内容需要人工确认」，跑完必须逐个看
NEEDS_REVIEW = {'conflict', 'error'}


def read(p):
    with open(p, 'r', encoding='utf-8', newline='') as f:
        return f.readlines()


def pick_snapshot(feature_ids, rel):
    """挑一份可用的快照：优先有 base 的那个功能（能做三方合并），否则第一个有 files 的。"""
    fallback = None
    for fid in feature_ids:
        ours = os.path.join(SNAP, fid, 'files', rel)
        if not os.path.exists(ours):
            continue
        if fallback is None:
            fallback = fid
        base = os.path.join(SNAP, fid, 'base', rel)
        if os.path.exists(base):
            return fid, base, ours
    if fallback:
        return fallback, None, os.path.join(SNAP, fallback, 'files', rel)
    return None, None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--upstream', required=True, help='新的上游源码根目录（含 server/ public/ shared/ …）')
    ap.add_argument('--out', default=os.path.join(REPO, 'staging', 'features-merged'))
    args = ap.parse_args()

    if not os.path.isdir(SNAP):
        sys.exit(f'找不到快照目录：{SNAP}')
    if not os.path.isdir(args.upstream):
        sys.exit(f'找不到上游目录：{args.upstream}')

    index = json.load(open(os.path.join(SNAP, 'index.json'), encoding='utf-8'))
    os.makedirs(args.out, exist_ok=True)

    # 同一文件可能被多个功能登记，只合并一次
    files = {}
    for feature in index:
        for entry in feature['files']:
            files.setdefault(entry['path'], []).append(feature['id'])

    report = []
    for rel, feature_ids in sorted(files.items()):
        fid, base, ours = pick_snapshot(feature_ids, rel)
        theirs = os.path.join(args.upstream, rel)
        dst = os.path.join(args.out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        row = {'features': feature_ids, 'file': rel, 'snapshot': fid}

        if ours is None:
            row['status'] = 'skipped'
        elif not os.path.exists(theirs):
            # 上游没有这个文件：本服新增的（AI 模块、nginx、dashboard…），原样保留
            shutil.copyfile(ours, dst)
            row['status'] = 'ours-only'
        elif base is None:
            # 上游这次才有这个文件，而我们是基于「不存在」改的：没有共同祖先，
            # 无法三方合并。保留我们的版本，人工确认上游版本是否要合并进来。
            shutil.copyfile(ours, dst)
            row['status'] = 'no-base-keep-ours'
        else:
            try:
                b, o, t = read(base), read(ours), read(theirs)
                if o == b:
                    # 我们没改过：直接跟上上游
                    shutil.copyfile(theirs, dst)
                    row['status'] = 'upstream-only'
                elif t == b:
                    # 上游没改过：保留我们的
                    shutil.copyfile(ours, dst)
                    row['status'] = 'custom-only'
                else:
                    # 两边都改了：三方合并
                    merged = ''.join(Merge3(b, o, t).merge_lines())
                    with open(dst, 'w', encoding='utf-8', newline='') as f:
                        f.write(merged)
                    blocks = merged.count('<<<<<<<')
                    row['status'] = 'conflict' if blocks else 'merged'
                    row['conflicts'] = blocks
            except Exception as e:                     # noqa: BLE001
                shutil.copyfile(ours, dst)
                row['status'] = 'error'
                row['error'] = str(e)[:200]
        report.append(row)

    counts = {}
    for r in report:
        counts[r['status']] = counts.get(r['status'], 0) + 1
    json.dump(report, open(os.path.join(args.out, 'report.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)

    print(f'快照目录: {SNAP}')
    print(f'上游目录: {args.upstream}')
    print(f'输出目录: {args.out}')
    print(f'共 {len(report)} 个文件')
    for status in sorted(counts):
        print(f'  {status:<20} {counts[status]}')

    review = [r for r in report if r['status'] in NEEDS_REVIEW]
    if review:
        print(f'\n需要人工处理 {len(review)} 个：')
        for r in review[:30]:
            detail = f" ({r['conflicts']} 处冲突)" if r.get('conflicts') else ''
            print(f"  {r['file']}{detail}")
        if len(review) > 30:
            print(f'  …还有 {len(review) - 30} 个，见 report.json')
        return 1

    nbase = counts.get('no-base-keep-ours', 0)
    if nbase:
        print(f'\n注意：{nbase} 个文件上游这次才新增，已保留本服版本；'
              f'确认是否需要把上游内容合并进来。')
    print('\n没有冲突，可以直接进入测试。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
