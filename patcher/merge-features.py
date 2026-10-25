import argparse, json, os, shutil
from merge3 import Merge3

ROOT = r'D:\Stronghold-Protocol'
SNAP = os.path.join(ROOT, 'patcher', 'features')

def read(p):
    with open(p, 'r', encoding='utf-8', newline='') as f:
        return f.readlines()

ap = argparse.ArgumentParser()
ap.add_argument('--upstream', required=True, help='new upstream node-1 source root')
ap.add_argument('--out', default=os.path.join(ROOT, 'staging', 'features-merged'))
args = ap.parse_args()

index = json.load(open(os.path.join(SNAP, 'index.json'), encoding='utf-8'))
os.makedirs(args.out, exist_ok=True)

# One merge per file, even when several features name it.
files = {}
for feature in index:
    for entry in feature['files']:
        rel = entry['path']
        files.setdefault(rel, []).append(feature['id'])

report = []
for rel, feature_ids in files.items():
    base = os.path.join(SNAP, feature_ids[0], 'base', rel)
    ours = os.path.join(SNAP, feature_ids[0], 'files', rel)
    theirs = os.path.join(args.upstream, rel)
    dst = os.path.join(args.out, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    row = {'features': feature_ids, 'file': rel}
    if not os.path.exists(theirs):
        shutil.copyfile(ours, dst)
        row['status'] = 'ours-only'
    elif not os.path.exists(base):
        shutil.copyfile(theirs, dst)
        row['status'] = 'theirs-new'
    else:
        try:
            b, o, t = read(base), read(ours), read(theirs)
            if o == b:
                shutil.copyfile(theirs, dst)
                row['status'] = 'upstream-only'
            elif t == b:
                shutil.copyfile(ours, dst)
                row['status'] = 'custom-only'
            else:
                merged = ''.join(Merge3(b, o, t).merge_lines())
                with open(dst, 'w', encoding='utf-8', newline='') as f:
                    f.write(merged)
                n = merged.count('<<<<<<<') + merged.count('>>>>>>>')
                row['status'] = 'conflict' if n else 'merged'
                row['conflicts'] = n
        except Exception as e:
            shutil.copyfile(ours, dst)
            row['status'] = 'error'
            row['error'] = str(e)[:160]
    report.append(row)

json.dump(report, open(os.path.join(args.out, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('files', len(report),
      'merged', sum(1 for x in report if x['status'] == 'merged'),
      'conflicts', sum(1 for x in report if x['status'] == 'conflict'),
      'blocks', sum(x.get('conflicts', 0) for x in report))
