# 样例稿件说明

本文件说明 `dongfang-review-handoff/发给皓天的一审文件/样例/` 下 3 篇稿件样本的**来源、选取理由、实测解析数据**。

> 复核工具：交接包内 `dsh/src/docx.js` 的 `parseDocxBuffer(buffer, name)`（Node 内置模块，零外部依赖）。
> 本文所有统计数字均为**对交付文件本身**实测所得，不是从清单里抄的。

---

## 一、样本从哪来

| 项目 | 说明 |
| --- | --- |
| 源目录 | `发给皓天的一审文件/`（《东方学刊》真实一审流程存档） |
| 规模 | 13 个季节目录，共 715 个文件；其中稿件 `.docx` 640 篇、`.doc` 27 篇（其余为 PDF 规范文件等，非稿件） |
| 稿件清单 | `dsh/data/corpus/manifest.json`（632 条 `.docx` 条目：path / sha256 / season / status / comments / paragraphs / revisions） |
| 格式普查 | `dsh/tools/.census-formats.json`（`rows[].raw`：表格 / 图片(drawing) / 文本框(txbxContent) / 脚注 / 域开始 等 XML 节点计数，用于挑选「格式复杂」样本） |

交接包只带 3 篇样本，其余稿件**未**放入交接包。

---

## 二、三篇一览

| 交付文件名 | 角色 | 期次 | 原件文件名 | 体积 | sha256（前 16 位） |
| --- | --- | --- | --- | --- | --- |
| `01-正常稿.docx` | 正常稿（无批注、无修订、普通结构） | 05-2024年秋（2024 年秋季刊） | 05-吴畅畅-政治化的主体及其狂热：重新理解"饭圈"与青年日常生活实践-文化.docx | 109,218 B | `24f0b96eeedbbe43…` |
| `02-带批注修订.docx` | 批注 + 修订痕迹稿 | 12-2026年夏（2026 年夏季刊） | 05-魏程琳-过程优化与增能社会：党的领导如何克服乡村民主弊端【0511一审done可返回给作者修订，0524作者返回】.docx | 126,415 B | `61f8b835f59041da…` |
| `03-格式复杂.docx` | 格式复杂稿（表格/图/域/脚注） | 06-2024年冬（2024 年冬季刊） | 美国经济增长模式解析：表外增长1213郭老师修订后返回.docx | 190,467 B | `a2350633c89a1e03…` |

三篇的 sha256 均与 `manifest.json` 记录一致——交付文件与原件**二进制完全相同，仅改了文件名**。

---

## 三、逐篇说明

### 01-正常稿.docx

- **原件位置**（相对 `发给皓天的一审文件/`）：

  ```text
  05-2024年秋【从这一期起就在word文档中一审了，在修订模式下完成，与作者沟通的内容通过批注体现，注释中无法加批注就用方头括号加内容来说明】\秋季刊稿件【毛条样，编务版，即接受修订，无痕迹、可排版的版本】\05-吴畅畅-政治化的主体及其狂热：重新理解"饭圈"与青年日常生活实践-文化.docx
  ```

- **期次**：05-2024年秋（2024 年秋季刊）；原件位于「编务版（无痕迹、可排版）」目录。
- **体积 / sha256**：109,218 B／`24f0b96eeedbbe4390437d0f667443df9cf574d8de8586ebcb9c27a9bec4e688`
- **选取理由**：comments = 0、revisions = 0，是编制干净、可直接排版的普通稿件；正文 164 段（含脚注共 223 段）落在要求的 100–250 段区间；无表格、无图片、无文本框、无域，适合作为「解析正常路径」的基线样本。

| 指标 | 实测值 |
| --- | --- |
| 批注 comments | 0 |
| 修订 revisions | 0（插入 0 / 删除 0） |
| 段落 paragraphs | 223（其中正文 164，其余为脚注段落） |
| 字符数 chars | 24,809 |
| 表格 tables | 0 |
| 图/嵌入对象 figures | 0 |
| 内嵌位图 images | 0 |
| 文本框（txbxContent） | 0 |
| 脚注 footnotes | 59（正文脚注引用标记 59 处） |
| 尾注 endnotes | 0 |
| 域 fields | 0 |
| 带批注锚点段落 | 0 |

### 02-带批注修订.docx

- **原件位置**（相对 `发给皓天的一审文件/`）：

  ```text
  12-2026年夏\2026夏季刊责编版\05-魏程琳\05-魏程琳-过程优化与增能社会：党的领导如何克服乡村民主弊端【0511一审done可返回给作者修订，0524作者返回】.docx
  ```

- **期次**：12-2026年夏（2026 年夏季刊）；原件位于「责编版（有修订痕迹）」目录，是「一审完成 → 作者返回」的版本。
- **体积 / sha256**：126,415 B／`61f8b835f59041daffebd0fd57d66772b79c40e078e0167cb38fd0d8acbf68ac`
- **选取理由**：批注 61 条（≥ 30）且修订 2,500 处（> 0），两个条件同时满足；31 个段落带批注锚点，批注含作者与时间（孙程姣、Wei、余小多 等），修订同时含插入与删除——可完整覆盖「批注锚点 ↔ 段落」「修订痕迹 ↔ 原文/改文」两条链路。

| 指标 | 实测值 |
| --- | --- |
| 批注 comments | 61（批注作者：孙程姣、Wei、Wei [2]、余小多） |
| 修订 revisions | 2,500（插入 1,658 / 删除 842） |
| 段落 paragraphs | 203（其中正文 115，其余为脚注段落） |
| 字符数 chars | 17,250 |
| 表格 tables | 0 |
| 图/嵌入对象 figures | 0 |
| 内嵌位图 images | 0 |
| 文本框（txbxContent） | 0 |
| 脚注 footnotes | 77（正文脚注引用标记 61 处） |
| 尾注 endnotes | 0 |
| 域 fields | 0 |
| 带批注锚点段落 | 31 |

> 口径提示：`manifest.json` 对本篇记 `revisions: 2941`，解析器实测为 2,500 处（插入 + 删除）。两者统计口径不同，**以解析器实测为准**；`comments` 两处一致（61）。

### 03-格式复杂.docx

- **原件位置**（相对 `发给皓天的一审文件/`）：

  ```text
  06-2024年冬\一审文件，带痕迹版\经济\美国经济增长模式解析：表外增长1213郭老师修订后返回.docx
  ```

- **期次**：06-2024年冬（2024 年冬季刊）。
- **体积 / sha256**：190,467 B／`a2350633c89a1e03ef211aa9a50cf610a0d74de97bc3fef59f8acdab3a59b98f`
- **选取理由**：按 `.census-formats.json` 全库排序，本篇是**表格最多的稿件（6 个，全库最大值；全库仅 84 篇含表格）**，同时含 9 个图/绘图对象、33 条脚注、4 个域（全部为 `HYPERLINK` 超链接域），并带 3 个页脚部件——「脚注 + 图表 + 域」同时成立，是结构最重的一篇。该稿本身无批注、无修订，格式复杂度与评审痕迹相互独立，便于单独验证格式识别与表格/图片/域提取。

| 指标 | 实测值 |
| --- | --- |
| 批注 comments | 0 |
| 修订 revisions | 0（插入 0 / 删除 0） |
| 段落 paragraphs | 618（其中正文 581，其余为脚注段落） |
| 字符数 chars | 33,150 |
| 表格 tables | 6（规模：10×4、13×5、20×6、5×6、5×6、8×4） |
| 图/嵌入对象 figures | 9（均为 `drawing` 对象） |
| 内嵌位图 images | 0（9 个绘图对象中没有解析出名目指向的位图，属图形/线条类对象） |
| 文本框（txbxContent） | 0 |
| 脚注 footnotes | 33 |
| 尾注 endnotes | 0 |
| 域 fields | 4（全部 `HYPERLINK`） |
| 带批注锚点段落 | 0 |
| 文档部件 | `document.xml`、`footnotes.xml`、`endnotes.xml`、`footer1~3.xml` |

---

## 四、统计口径

1. `paragraphs` 是**全部部件**的段落总数（含脚注、页脚段落）；`正文段落` 仅指 `word/document.xml` 中的正文段。要求里的「正文段落约 100–250」按两者看都成立（01 为 164 正文 / 223 总数）。
2. `revisions` = 解析出的修订标记总数 = `insertions`（插入）+ `deletions`（删除）。
3. `figures` 是图中的**对象数**（`drawing` / `pict` / `object` 节点）；`images` 是其中真正解析到内嵌位图（`figures[].media`）的数量，二者不等。文本框按 `w:txbxContent` 计，单独统计。
4. `footnotes` 已排除 separator / continuationSeparator 与空条目，只算真实脚注；`正文脚注引用标记` 是正文里 `w:footnoteReference` 的出现次数，两者因「一条脚注可被引用多次/无正文引用」可能不等。

---

## 五、语料复核时的两个坑（选样时已排除）

1. **扩展名是 `.docx`、内容其实是 OLE2 旧格式**：语料中存在这类文件（例：`12-2026年夏\2026夏季刊责编版\08-陈雨思\` 批次下的若干「.docx」）。`parseDocxBuffer` 会明确抛出「这是旧版 Word 格式（OLE2 复合文档）…」，本次选样已排除。开发者批量遍历语料时，务必把这个报错当作**预期情况**处理，不要当成解析器缺陷。
2. **清单统计 ≠ 解析实测**：`manifest.json` 的 `paragraphs` / `revisions` 与 `parseDocxBuffer` 的实测值存在口径差（例如 03 原件 manifest 记 623 段、实测 618 段；02 的 revisions 见上）。以解析器实测为准，清单只用于初筛。

另：交接包内的 `dsh/samples/test.docx`（sha256 `7525232d…`）是同一语料中的《作为经济基础的国家：对历史唯物主义的再认识》一篇，已作为内置演示文档随代码提供；本次三篇样本**刻意避开**了它，避免样本集与内置示例重复。

---

## 六、使用范围与保密声明

- 本目录 3 篇稿件均为**《东方学刊》真实评审原件**，含作者原文、责编批注与修订痕迹，属于内部工作文件。
- **仅限接续开发的工程师在本地做解析、批注锚点、修订痕迹、格式识别等功能的开发自测与回归验证使用**。
- **请勿外传**：不要上传到公开仓库、网盘、第三方模型/训练服务或任何外部系统，不要用于对外产品或对外演示；随代码交付时按交接约定处理（不进入公开分发物）。
- 若开发结束不再需要，请连同整个 `dongfang-review-handoff/发给皓天的一审文件/` 一并清理。

---

## 七、如何复核本文数字

在交接包根目录新建 `verify-samples.mjs`（仅演示，不必随包分发）：

```js
import fs from 'node:fs';
import { parseDocxBuffer } from './dsh/src/docx.js';

for (const name of ['01-正常稿.docx', '02-带批注修订.docx', '03-格式复杂.docx']) {
  const buf = fs.readFileSync(`发给皓天的一审文件/样例/${name}`);
  const doc = parseDocxBuffer(buf, name);
  const all = Object.values(doc.parts).flatMap((p) => p.paragraphs);
  console.log(name, {
    ...doc.stats,                                    // paragraphs/chars/comments/insertions/deletions/tables/figures/images/footnotes/endnotes
    revisions: doc.revisions.length,                 // 插入 + 删除
    bodyParagraphs: doc.paragraphs.length,           // 正文段落
    textboxes: all.reduce((s, p) => s + (p.textboxes || []).length, 0),
    fields: all.reduce((s, p) => s + (p.fields || []).length, 0),
    tableDims: doc.tables.map((t) => `${t.rows.length}x${t.rows[0]?.length ?? 0}`),
  });
}
```

```powershell
node verify-samples.mjs
Get-FileHash -Algorithm SHA256 '发给皓天的一审文件\样例\01-正常稿.docx'
```
