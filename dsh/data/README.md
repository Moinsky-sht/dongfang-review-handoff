# data/ 说明

这个目录里**只需要保留 `standards/`**（体例规范抽取出的纯文本 + 一张规范页截图，是规则库的由来与核对依据）。

其余子目录都是**运行时自动生成**的本地数据，不属于项目源码，首次启动后才会出现：

| 目录 | 内容 | 是否可删 |
| --- | --- | --- |
| `sessions/` | 稿件会话快照（解析结果、工作版本指针、审阅记录） | 删掉＝丢掉历史会话，不影响启动 |
| `working-versions/` | 上传原稿与每次自动修改后的 DOCX 工作版本（带哈希与父版本） | 删掉＝历史修改无法撤销/恢复 |
| `workspaces/` | 工作台队列与当前查看稿件 | 可删 |
| `ingestions/` | 上传登记与断点续传记录 | 可删 |
| `jobs/` | 持久审阅任务、运行身份、执行租约、待发布结果 | 有未完成任务时不要删 |
| `review-jobs/` `review-plans/` | 审阅任务账本与计划 | 有未完成任务时不要删 |
| `ark-executions/` | 模型请求账本（请求/响应哈希、用量、未知发送核对） | 可删（会丢审计证据） |
| `comments/` | 历史批注索引（供模型参考的案例检索） | 可删 |
| `audit/` | 审计记录与报告导出 | 可删 |
| `corpus/` | 语料清单 `manifest.json`（批量工具用）。**本交接包只带了 3 条样例的清单**（`data/corpus/manifest.json`），对应 3 篇样例；原项目 632 条清单未随包提供 | 可删（删后 `cli-review --pick` / `--sha` 不可用，直接传文件路径不受影响） |
| `legacy-imports/` | 旧服务记录离线迁移的产物 | 可删 |
| `live-*/` `verify/` `optimization/` | 开发期的实验/验收目录，**本交接包未包含** | — |

> 所有存储根都可以用环境变量改到别处（`DSH_SESSION_ROOT`、`DSH_WORKING_VERSION_ROOT`、
> `DSH_WORKSPACE_ROOT`、`DSH_JOB_ROOT`、`DSH_INGESTION_ROOT`、`DSH_AUDIT_ROOT`、
> `DSH_LEGACY_ROOT`、`DSH_ARK_EXECUTION_ROOT` 等），详见 `../README.md` 与源码。
