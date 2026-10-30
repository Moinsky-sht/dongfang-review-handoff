"""把历史批注与修订痕迹还原成"带上下文的审校证据"。

输入：data/corpus/*.json（由 OOXML 只读解析得到）
输出：
  data/comments/occurrences.json   每条批注 + 被批注段落上下文 + 段落位置
  data/corpus/revision-pairs.json  同段内的 删除->插入 对照（真实改错样例）

只读原始语料，不修改任何稿件。
"""
from pathlib import Path
from lxml import etree as E
import json, re, sys, collections

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
def w(s): return '{' + W + '}' + s

BASE = Path(__file__).resolve().parent.parent
CORPUS = BASE / 'data' / 'corpus'
OUT = BASE / 'data' / 'comments'
OUT.mkdir(parents=True, exist_ok=True)

def para_style(properties_xml):
    """从 pPr XML 里取样式名与是否居中，用于体例判断。"""
    if not properties_xml:
        return '', False
    try:
        node = E.fromstring(properties_xml.encode('utf-8'))
    except Exception:
        return '', False
    style = node.find(w('pStyle'))
    name = style.get(w('val')) if style is not None else ''
    align = node.find(w('jc'))
    centered = align is not None and align.get(w('val')) == 'center'
    return name or '', centered

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    files = sorted((CORPUS / 'docs').glob('*.json'))
    files = [f for f in files if len(f.stem) == 64]
    manifest = json.loads((CORPUS / 'manifest.json').read_text(encoding='utf-8'))
    path_by_sha = {}
    season_by_sha = {}
    for row in manifest:
        sha = row.get('sha256')
        if not sha:
            continue
        path_by_sha.setdefault(sha, row['path'])
        season_by_sha.setdefault(sha, row.get('season', ''))

    occurrences = []
    revisions = []
    for f in files:
        sha = f.stem
        try:
            doc = json.loads(f.read_text(encoding='utf-8'))
        except Exception as ex:
            print('skip', f.name, ex, file=sys.stderr)
            continue
        paras = doc.get('paragraphs') or []
        by_id = {p['id']: i for i, p in enumerate(paras)}
        # 只保留正文（document.xml）段落，脚注另标记
        for c in doc.get('comments') or []:
            text = (c.get('text') or '').strip()
            if not text:
                continue
            anchors = c.get('anchors') or []
            idxs = [by_id[a] for a in anchors if a in by_id]
            doc_part = 'document.xml'
            if idxs:
                doc_part = paras[idxs[0]]['part']
            anchor_idx = min(idxs) if idxs else -1
            ctx_before = ctx_after = ''
            if anchor_idx >= 0:
                window = [paras[i]['text'] for i in range(max(0, anchor_idx - 2), anchor_idx) if paras[i]['part'] == doc_part]
                ctx_before = '\n'.join(window)[-400:]
                window2 = [paras[i]['text'] for i in range(anchor_idx + 1, min(len(paras), anchor_idx + 3)) if paras[i]['part'] == doc_part]
                ctx_after = '\n'.join(window2)[:400]
            occurrences.append({
                'sha256': sha,
                'file': path_by_sha.get(sha, ''),
                'season': season_by_sha.get(sha, ''),
                'commentId': c.get('id'),
                'author': c.get('author'),
                'date': c.get('date'),
                'text': text,
                'part': doc_part,
                'paragraphIndex': anchor_idx,
                'anchorText': paras[anchor_idx]['text'] if anchor_idx >= 0 else '',
                'anchorStyle': para_style(paras[anchor_idx].get('properties', ''))[0] if anchor_idx >= 0 else '',
                'contextBefore': ctx_before,
                'contextAfter': ctx_after,
            })
        # 修订痕迹：把每段的 del / ins 文本抽出来做真实改写对照
        for p in paras:
            before = (p.get('before') or '').strip()
            after = (p.get('text') or '').strip()
            if not before or not after or before == after:
                continue
            revisions.append({
                'sha256': sha,
                'file': path_by_sha.get(sha, ''),
                'season': season_by_sha.get(sha, ''),
                'part': p['part'],
                'paragraphIndex': p['index'],
                'before': before,
                'after': after,
                'style': para_style(p.get('properties', ''))[0],
            })
        print('done', sha[:8], file=sys.stderr)

    (OUT / 'occurrences.json').write_text(json.dumps(occurrences, ensure_ascii=False), encoding='utf-8')
    (CORPUS / 'revision-pairs.json').write_text(json.dumps(revisions, ensure_ascii=False), encoding='utf-8')

    by_season = collections.Counter(o['season'] for o in occurrences)
    stats = {
        'documents': len(files),
        'commentOccurrences': len(occurrences),
        'revisionPairs': len(revisions),
        'bySeason': dict(sorted(by_season.items())),
        'uniqueCommentTexts': len({o['text'] for o in occurrences}),
    }
    (OUT / 'occurrence-stats.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(stats, ensure_ascii=False))

if __name__ == '__main__':
    main()
