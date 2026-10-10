---
name: office-files
description: 处理办公文档与 PDF：读取 pdf/docx/pptx/xlsx 的内容，或从结构化的要求生成 docx/xlsx/pptx、合并拆分 pdf。当用户提到 Word/表格/幻灯片/PDF、或项目里出现这类文件需要读一遍、改一版、合并拆分时使用。
---

## 何时使用

用户给出或要求产出 `.pdf`、`.doc/docx`、`.xlsx/xls`、`.pptx` 文件，且需要「读内容」或「生成/加工」时，一律走下面这套 `office_*` 工具，**不要自己去解析这些二进制/zip 格式**。

## 工具清单

| 工具 | 用途 |
|---|---|
| `office_extract` | **读**：按扩展名抽取内容——pdf 抠文字、docx 抽正文、xlsx 把每个工作表展开成行列表格、pptx 抽每页标题与要点。超长自动截断 |
| `office_write_docx` | 生成 Word：`blocks` 按序写内容块（`h1/h2/h3` 标题、`p` 段落、`bullet` 圆点、`numbered` 编号） |
| `office_write_xlsx` | 生成 Excel：`sheets` 每个工作表给 `{name?, rows}`，`rows` 是二维数组（首行通常是表头） |
| `office_write_pptx` | 生成 PPT：`slides` 每页 `{title?, bullets?}` |
| `office_pdf_utils` | 处理已有 PDF：`op` 为 `merge`（用 `paths` 合并多份）或 `split`（用 `src` + `pages` 按页拆分） |

## 工作流

### 读
1. `office_extract` 读入内容，理解后再决定下一步。
2. xlsx 的表格文本保留制表符分隔，直接据此组织回答或转成别的内容。

### 写 / 改
1. 先 `office_extract` 把原稿读出来（改的是已有文件时尤其要读，别凭空编）。
2. 再把整理好的内容交给 `office_write_*` 生成**新文件**（这些工具是「从零生成」语义，不是就地改版；文件会写到给定的路径，覆盖需确认）。
3. `out` 路径给绝对路径或相对项目路径均可；若目标目录不存在，先建目录再写。
4. 生成完成后在回复里给出文件路径。

### 注意事项
- 读 pdf 是**文字抽取**，扫描件/纯图片页抽不到文字属正常，予以说明；需要改 pdf 版面或加中文文本时，优先让用户提供源文件（docx/pptx），读出来重新生成更可靠。
- 中文在 docx/xlsx/pptx 生成中正常支持；pdf 不做「从零排版生成」（中文字体内嵌开销大），合并/拆分已有 pdf 用 `office_pdf_utils`。
- 表格转 Excel 时注意列对齐、单元格尽量保持原始类型（数字别全变字符串）。