/**
 * 路径解析：让工具脚本**可移植**。
 *
 * ── 为什么需要这个文件 ──
 * 22 个工具脚本原本把语料根目录**写死**成
 * `<学术目录>\发给皓天的一审文件`（某台机器上的绝对路径）。
 * 后果是这个项目**只能在那一台机器的那一个位置跑**：
 * 文件夹一旦被拷贝走（换机器、换盘符、改目录名），
 * 所有需要语料的脚本都会静默指向不存在的位置，
 * 报出来的错是"找不到文件"，而不是"路径配错了"，很难查。
 *
 * ── 现在的规则 ──
 * 目录结构约定（`dsh` 与两个数据目录**同级**）：
 *
 *   学术/
 *   ├── dsh/                    ← 代码（本文件在 dsh/tools/ 下）
 *   ├── 00-体例与规范/            ← 期刊体例规范
 *   └── 发给皓天的一审文件/         ← 稿件语料
 *
 * 于是从本文件出发 `../..` 就是 `学术`，再拼子目录即可 ——
 * **无论整个文件夹被拷到哪里都能算对**。
 *
 * ── 需要覆盖时 ──
 * 环境变量优先，便于把语料放在别处：
 *   DSH_ACADEMIC_ROOT   学术目录
 *   DSH_CORPUS_ROOT     稿件语料目录
 *   DSH_STANDARDS_ROOT  体例规范目录
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `学术` 目录：`dsh/tools/` 往上两级 */
export const ACADEMIC_ROOT = process.env.DSH_ACADEMIC_ROOT
  || path.resolve(HERE, '..', '..');

/** 稿件语料目录 */
export const CORPUS_ROOT = process.env.DSH_CORPUS_ROOT
  || path.join(ACADEMIC_ROOT, '发给皓天的一审文件');

/** 期刊体例规范目录 */
export const STANDARDS_ROOT = process.env.DSH_STANDARDS_ROOT
  || path.join(ACADEMIC_ROOT, '00-体例与规范');

/** `dsh` 自己的目录 */
export const DSH_ROOT = path.resolve(HERE, '..');
