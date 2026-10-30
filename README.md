# 《东方学刊》审稿智能体 · 开发交接包

> 交接日期：2026-10-30
> 来源项目：原工作副本 `dsh/`（最新版，2026-10-13）
> 本包定位：**把代码交给下一位开发者继续开发**，带最小可跑的稿件样例；不含服务器部署与任何真实密钥。

---

## 1. 这是什么

一个网页端的中文学术期刊审稿智能体，针对《东方学刊》的编辑体例与一审惯例而建：

```
导入 .docx → 左右对照预览（修改前 / 修改后）
           → 格式体例审阅（标题、摘要、关键词、注释、图表、标点、数字……）
           → 内容问题审阅（语法、语病、词汇、逻辑、引文、事实）
           → 导出「批注 Word」/ 审阅报告
```

- **规则库有真实依据**：来自《东方学刊》发文形式规范（2023 版）与 GB/T 15834、GB/T 15835、CY/T 170/171/173 等标准，原件在 `00-体例与规范/`。
- **模型审阅可选**：接入火山方舟（Ark）模型做深度审阅；不配 API Key 时，规则审阅完全离线可用，且不会误发模型请求。
- **零依赖**：只用 Node 内置模块（`node:http` / `node:fs` / `node:zlib`），**不需要 `npm install`**。要求 Node ≥ 18（交接时在本机 Node v25.8.0 实测）。

## 2. 三分钟跑起来

```powershell
cd dsh
node server.mjs
# 或者双击 dsh\start.bat
```

浏览器打开 <http://127.0.0.1:3210>。

- 首次启动会在 `dsh/data/` 下自动生成运行数据目录（sessions / jobs / working-versions …），不需要手工建库；说明见 `dsh/data/README.md`。
- 默认只监听 `127.0.0.1`，不对外开端口。要改端口：`$env:PORT=3211` 后再启动。
- 不需要数据库、不需要构建步骤，前端是原生 JS，`public/vendor/` 里已带好 docx 预览组件。

### 冒烟验证（两条命令）

```powershell
# 1) 健康检查
Invoke-RestMethod http://127.0.0.1:3210/api/health
# 期望：ok=true，arkConfigured=false（未配 Key 时），rules 里有 format/language/citation 条数
# 2) 页面
Invoke-WebRequest http://127.0.0.1:3210/ -UseBasicParsing | Select-Object StatusCode
```

## 3. 模型审阅（可选，需自备 Key）

- 模型调用代码在 `dsh/src/ark.js`、`src/ark-execution-store.js`、`src/ark-endpoint-config.js` 等，**本包完整保留**，但**不包含任何真实 API Key**。
- 启用方式（三选一，只写在本机环境变量里）：

  ```powershell
  $env:ARK_API_KEY="你的火山方舟 API Key"
  $env:ARK_MODEL="deepseek-v4-1-flash-260910"   # 可选，默认同此
  $env:ARK_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"  # 可选，默认同此
  ```

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ARK_API_KEY` | 启用模型时必填 | 不填＝仅规则审阅 |
| `ARK_BASE_URL` | 否 | 默认 `https://ark.cn-beijing.volces.com/api/v3` |
| `ARK_MODEL` | 否 | 默认 `deepseek-v4-1-flash-260910` |
| `ARK_MODEL_ENDPOINTS` | 否 | 接入点映射 JSON，一般不用配 |
| `DSH_REVIEW_WORKERS` | 否 | 稿件并发，小机器建议 1–2 |

模板见包根目录 `.env.example`（只有占位符，没有真实值）。

> 模型调用按 token 计费，请用**你自己的账号**；页面里关闭「模型深度审阅」后不会再请求模型。

## 4. 目录结构

```
dongfang-review-handoff/
├── README.md                    ← 本文件
├── 交接清单.md                   ← 包内/包外清单、脱敏与测试结论
├── 测试报告.md                   ← 端到端实测结果（启动/审阅/导出/自测/语法）
├── 脱敏报告.md                   ← 服务器与 API 痕迹逐条审计
├── .env.example                 ← 环境变量模板（无真实值）
├── dsh/                         ← 应用代码（入口在这里）
│   ├── server.mjs               ← HTTP 服务 + 静态页 + 全部 API 路由
│   ├── src/                     ← 43 个模块（解析 / 扫描 / 锚点 / 存储 / 模型 / 导出）
│   ├── public/                  ← 前端（原生 JS 三栏界面 + docx-preview vendor）
│   ├── rules/                   ← 规则库 JSON + INSTRUCTIONS.md
│   ├── tools/                   ← 198 个测试/批量/评测脚本（.mjs + .py + 对抗样本）
│   ├── samples/test.docx        ← 内置自测样本
│   ├── data/standards/          ← 体例规范抽取文本（规则库的由来）
│   ├── data/README.md           ← 运行数据目录说明
│   ├── README.md                ← 原项目完整文档（数据流、接口、存储、验收）
│   └── start.bat                ← Windows 一键启动
├── 00-体例与规范/                ← 6 份体例规范 PDF（规则依据）
├── 发给皓天的一审文件/            ← 3 篇真实稿件样例（保密，仅开发测试用）
│   ├── 样例/01-正常稿.docx
│   ├── 样例/02-带批注修订.docx
│   ├── 样例/03-格式复杂.docx
│   └── README-稿件说明.md
└── docs/                        ← 需求与验收口径（已脱敏）
```

> **为什么代码在 `dsh/` 子目录**：`dsh/tools/paths.mjs` 按「代码目录的上级 = 学术根目录」解析语料与规范目录，
> 保持 `dsh/` + `00-体例与规范/` + `发给皓天的一审文件/` 同级，工具脚本换机器、换盘符都不用改代码。

## 5. 关键文件与模块

| 位置 | 作用 |
| --- | --- |
| `dsh/server.mjs` | 唯一入口：HTTP 服务、静态资源、约 60 个 API 路由（上传/审阅/导出/工作台/规则管理） |
| `dsh/src/docx.js` | DOCX 解析（正文、脚注、尾注、表格、图片、域代码、批注、修订） |
| `dsh/src/scanner-format.js` / `scanner-language.js` / `scanner-citation.js` | 三类规则扫描器（格式 / 语言 / 引文） |
| `dsh/src/review.js` | 审阅编排（规则 → 锚点 → 模型 → 复核 → 判定） |
| `dsh/src/ark.js` | 模型调用、请求账本、并发池、分批与补问 |
| `dsh/src/working-version.js` / `session-store.js` / `job-store.js` / `workspace-store.js` | 工作版本、会话快照、持久任务、工作台的落盘存储 |
| `dsh/src/docx-comments.js` / `docx-patches.js` / `docx-clean.js` | 批注 Word 导出、自动修改补丁、导入清洗 |
| `dsh/rules/*.json` | 格式 82 条 / 语言 25 条 / 引文 31 条（以 `GET /api/rules` 返回为准） |
| `dsh/public/app.js` | 前端全部交互（约 340 KB，原生 JS，无构建） |
| `dsh/tools/` | 自测、批量验证、评测、诊断脚本；`selftest.mjs` 是改代码前最先跑的 |

## 6. 改代码前建议先做的事

1. 读 `dsh/README.md`（原项目完整说明：数据流、接口清单、存储格式、验收方法、已知限制）。
2. 读 `docs/验收目标.md`（需求与验收口径，接手后按它对齐）。
3. 跑一遍：

```powershell
cd dsh
node tools/selftest.mjs                        # 单元自测（见下方"预期失败"说明）
node tools/verify-requirements.mjs             # 需求验收（见下方"预期失败"说明）
node tools/cli-review.mjs "..\发给皓天的一审文件\样例\01-正常稿.docx" --no-model   # 命令行规则审阅
```

> **预期失败**（不是代码坏了，是交接包只带 3 篇样例、没有原项目的派生产物）：
> - `selftest.mjs` 实测 **403 通过 / 4 失败**：4 项依赖 `data/comments/occurrences.json`、`occurrence-stats.json`、`topics.json`、`data/corpus/revision-pairs.json` 这些由全量语料生成的派生数据（原项目 19 GB 运行数据未随包提供）。
> - `verify-requirements.mjs` 实测 **32/35**：1 项需要 715 篇全量语料做留出集重叠检查，2 项是渲染/截图检查，需要 Playwright/Tabbit 浏览器环境（本包未带）。
> - 其余失败若与上两类无关，才需要当代码问题排查。完整实测见包根 `测试报告.md`。
> - 注意：`verify-requirements.mjs` 内置 `BASE=http://127.0.0.1:3210`，跑它之前要用**默认 3210 端口**启动服务。


4. 改完代码再跑 `node tools/verify-all.mjs`（全量回归，较久）。

## 7. 已知限制（交接时如实说明）

- **模型结论不可复现**：同一篇稿子跑两次，模型发现的问题只有约 2% 重合（temperature=0 也只能压到数量波动 2.9%）；规则类问题完全可复现。模型结论**不进入**最终判定。
- **导出批注 Word** 目前用正文整段批注；准确的来源字符范围单独保存在导出记录里。
- **导出的 .docx 不含一键修改回写**：一键改只改服务端解析出的文档，不改原文件。
- **渲染/截图类验证脚本**依赖 Playwright 与浏览器（本包未带），需要时自行安装。
- **旧 `.doc`（非 docx）** 需要 LibreOffice 做格式转换（本包未带 LibreOffice 运行时）。
- 当前运行的模型不接受图像输入，正确性判定靠 DOM 计算样式断言 + PNG 像素校验，不靠"看"截图。

## 8. 交接边界：本包**不包含**什么

按委托方要求，**服务器与 API 凭据相关的一律不放入**：

| 不包含 | 说明 |
| --- | --- |
| 服务器信息 | 服务器 IP、域名、SSH 私钥（`*.pem`）、systemd 单元、Caddy/nginx 配置、部署脚本与部署文档 |
| 真实凭据 | 任何真实 `ARK_API_KEY`、飞书/云账号信息、`.env` 文件 |
| 运行数据 | 约 19 GB 历史运行记录（`data/optimization`、`data/live-*`、`data/corpus/docs` 等）、`reports/`、`tmp/` |
| 依赖与运行时 | `node_modules/`（项目零依赖）、`.tools/`（LibreOffice）、`.claude/`（本机助手配置） |
| 内部执行日志 | `长周期执行路线图.md`、`24h-plan.md`、`archive/`（如需另行提供） |
| 全量语料 | 715 个文件（640 份 `.docx` + 27 份 `.doc`，其余为 PDF 等）只保留 3 篇样例 |

> 需要部署上线时，请按自己的服务器环境重新写 systemd/反代配置；服务默认只监听 `127.0.0.1`，公网暴露前务必自行加鉴权。

## 9. 验证与脱敏记录

- 实测结论见 [`测试报告.md`](测试报告.md)：启动、健康检查、3 篇样例导入 + 规则审阅、导出链路、自测脚本、全量语法检查。
- 脱敏审计见 [`脱敏报告.md`](脱敏报告.md)：逐条列出服务器/API 痕迹的命中与处置。

## 10. 接手顺序（建议）

1. `node -v` 确认 ≥ 18 → `cd dsh && node server.mjs` → 打开页面。
2. 用「`发给皓天的一审文件\样例\01-正常稿.docx`」走一遍：导入 → 规则审阅 → 导出报告。
3. 读 `dsh/README.md` 与 `docs/验收目标.md`。
4. 配自己的 `ARK_API_KEY`，再打开「模型深度审阅」验证模型链路。
5. 从 `dsh/tools/selftest.mjs` 开始改代码，改完跑 `verify-all.mjs`。
