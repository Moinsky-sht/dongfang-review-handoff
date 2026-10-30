"""把主题批次切成小片段（每片 <= 约 8000 字符），并生成子任务指令文件。"""
from pathlib import Path
import re, sys, json

BASE = Path(__file__).resolve().parent.parent
SRC = BASE / 'data' / 'comments' / 'topic-batches'
DST = BASE / 'data' / 'comments' / 'chunks'

MAX_CHARS = 8000

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    DST.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for f in sorted(SRC.glob('*.txt')):
        text = f.read_text(encoding='utf-8')
        # 以 ### 开头的块为切分单位
        blocks = re.split(r'(?m)^(?=### )', text)
        blocks = [b for b in blocks if b.strip()]
        group_dir = DST / f.stem
        group_dir.mkdir(exist_ok=True)
        chunk, size, idx = [], 0, 0
        files = []
        def flush():
            nonlocal chunk, size, idx
            if not chunk:
                return
            p = group_dir / f'{idx:03d}.txt'
            p.write_text(''.join(chunk), encoding='utf-8')
            files.append({'file': str(p.relative_to(BASE)), 'kb': round(len(''.join(chunk)) / 1024, 1), 'blocks': len(chunk)})
            idx += 1
            chunk, size = [], 0
        for b in blocks:
            if size + len(b) > MAX_CHARS and chunk:
                flush()
            chunk.append(b)
            size += len(b)
        flush()
        manifest[f.stem] = {'source': f.name, 'totalKB': round(len(text) / 1024), 'chunks': files, 'blocks': len(blocks)}
    (DST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: {'chunks': len(v['chunks']), 'blocks': v['blocks']} for k, v in manifest.items()}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
