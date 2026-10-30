"""对 8687 条批注做主题统计，并生成按主题切分的小批次阅读材料。

输出：
  data/comments/topics.json          主题 -> 批注条数与样例
  data/comments/topic-batches/*.txt  按主题聚合的紧凑阅读材料（供规则归纳）
"""
from pathlib import Path
import json, re, sys, collections

BASE = Path(__file__).resolve().parent.parent
COMMENTS = BASE / 'data' / 'comments'
OUT = COMMENTS / 'topic-batches'
OUT.mkdir(parents=True, exist_ok=True)

TOPICS = {
    '格式-标题与编号': r'标题|层级|一级|二级|三级|编号|序号|小标题|层级|目录|栏目|章节|加粗|居中|左对齐|缩进|空行|段首|空格|字体|字号|楷体|宋体|黑体|仿宋|Times|五号|小四|四号|行距|页边距|页眉|页脚|篇幅|字数|排版',
    '格式-摘要关键词作者': r'摘要|内容提要|提要|关键词|关键字|作者简介|基金|课题|项目编号|署名|单位|通讯作者|英文摘要|Abstract|Key ?words|注释体例|收稿',
    '格式-标点符号': r'标点|顿号|逗号|句号|分号|冒号|引号|书名号|括号|方头括号|破折号|连接号|省略号|感叹号|问号|间隔号|中点|全角|半角|中文标点|英文标点|点号|标示',
    '格式-数字用法': r'数字|阿拉伯|汉字数字|中文数字|约数|年代|世纪|年份|百分比|百分号|计量单位|量词|区间|起止|页码|公元|纪年',
    '格式-图表': r'图表|表格|插图|图题|表题|资料来源|数据来源|单位|坐标|纵轴|横轴|图注|表注|行列|三线表|截图|图片|分辨率|清晰',
    '格式-注释著录': r'脚注|尾注|注释|注号|出处|著录|文献|参考文献|版本|页码|出版社|出版年|期号|卷|引文格式|标注|析出|著者|译者|译名|斜体|书名号|p\.|pp\.',
    '格式-网络来源': r'网址|链接|URL|http|浏览日期|访问日期|发布日期|网站|公众号|网页|人民网|新华网|政府网|数据库|最后浏览|最后访问',
    '语言-语病搭配': r'搭配|成分|残缺|赘余|重复|啰嗦|累赘|语病|不通|拗口|生硬|语序|歧义|指代|主语|谓语|宾语|定语|状语|句子|长句|断句|欧化|翻译腔|病句|表述不清|读不懂|看不懂|费解|拗',
    '语言-词汇用词': r'用词|词汇|词语|错别字|别字|错字|误用|生造|简称|全称|术语|概念|提法|措辞|说法|改为|建议改|换为|改成|应该是|应为|似乎|口语|书面语|文白|文言|成语|熟语|雅驯|不规范',
    '语言-逻辑结构': r'逻辑|论证|论据|结论|推论|跳跃|自相矛盾|前后矛盾|不一致|不统一|呼应|层次|结构|过渡|承接|转折|递进|因果|并列|总起|总结|重复论述|冗余|段落|篇幅过长|删减|压缩',
    '内容-事实核查': r'事实|核实|核对|核查|查证|有误|错误|不准确|不准|数据|统计|来源|依据|证据|佐证|是否准确|请核|待核|存疑|疑问|确认|出处|原文|原书|页码不符|张冠李戴',
    '内容-政治把关': r'政治|敏感|意识形态|提法|中央|党中央|习近平|总书记|党的|国家|政策|表述|口径|官方|规范表述|不宜|慎用|把关|稳妥|导向',
    '内容-译名与专名': r'译名|译法|翻译|原文|外文|英文|人名|地名|机构名|国名|统一|简称|全称|首字母|斜体|括号备注',
    '内容-学术规范': r'学术|引用|抄袭|原创|创新|贡献|文献综述|研究现状|学理|规范|体例|摘要与正文|标题与内容|文不对题|内容与标题|重复发表',
}

def topic_of(text):
    hits = []
    for name, pat in TOPICS.items():
        if re.search(pat, text):
            hits.append(name)
    return hits or ['其他']

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    occ = json.loads((COMMENTS / 'occurrences.json').read_text(encoding='utf-8'))
    revs = json.loads((BASE / 'data' / 'corpus' / 'revision-pairs.json').read_text(encoding='utf-8'))

    topic_counts = collections.Counter()
    topic_samples = collections.defaultdict(list)
    other = []
    for o in occ:
        ts = topic_of(o['text'])
        for t in ts:
            topic_counts[t] += 1
        if ts == ['其他']:
            other.append(o)
        for t in ts[:2]:
            if len(topic_samples[t]) < 400:
                topic_samples[t].append(o)

    # 按主题输出紧凑阅读材料
    index = {}
    for i, (topic, count) in enumerate(sorted(topic_counts.items(), key=lambda kv: -kv[1])):
        items = topic_samples[topic]
        safe = re.sub(r'[\\/:*?"<>|]', '_', topic)
        lines = []
        for o in items:
            anchor = (o.get('anchorText') or '').replace('\n', ' ')[:160]
            lines.append(f"### {topic} | {o['file'].split(chr(92))[-1][:60]} | 锚点：{anchor}\n{o['text']}\n")
        path = OUT / f'{i:02d}-{safe}.txt'
        path.write_text('\n'.join(lines), encoding='utf-8')
        index[topic] = {'count': count, 'batch': path.name, 'chars': sum(len(x) for x in lines)}

    (COMMENTS / 'topics.json').write_text(json.dumps({
        'topicCounts': dict(topic_counts.most_common()),
        'index': index,
        'unclassified': len(other),
        'totalOccurrences': len(occ),
        'revisionPairs': len(revs),
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    # 修订对照：抽取"短句级"的改写，用于语言规则的真实样例
    shorts = [r for r in revs if 2 <= len(r['before']) <= 60 and 2 <= len(r['after']) <= 60 and r['before'] != r['after']]
    by_pair = collections.Counter((r['before'], r['after']) for r in shorts)
    sample = [{'before': b, 'after': a, 'count': c} for (b, a), c in by_pair.most_common(3000)]
    (COMMENTS / 'revision-short-pairs.json').write_text(json.dumps(sample, ensure_ascii=False, indent=1), encoding='utf-8')

    print(json.dumps({'topics': dict(topic_counts.most_common()), 'unclassified': len(other), 'shortRevisionPairs': len(sample)}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
