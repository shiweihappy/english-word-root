# english-word-root
英语词根词缀学习

基于 `XDF.pdf` 的本地离线学习工具，包含：

- 词根/词缀检索与浏览
- 词根详情（例词 + 拆解 + 中文释义）
- 闪卡训练（显示答案 / 记住 / 再看）
- 选择题训练（记录正确率）
- 本地进度保存（localStorage）
- 进度 JSON 导出/导入恢复

## 目录结构

- `scripts/extract_xdf.py`：PDF 抽取与清洗脚本
- `scripts/validate_roots.py`：基础数据校验脚本
- `public/data/roots.json`：结构化词条数据
- `public/index.html`：页面入口
- `public/app.js`：前端逻辑（Hash 路由、训练、存储）
- `public/styles.css`：样式

## 数据抽取

```bash
python3 scripts/extract_xdf.py --pdf XDF.pdf --out public/data/roots.json
```

默认会调用：

```bash
pdftotext -layout XDF.pdf -
```

## 数据校验

```bash
python3 scripts/validate_roots.py
```

校验项：

- JSON 可解析
- `meta.entryCount > 0`
- `meta.exampleCount > 0`
- 词条字段完整率 >= 90%

## 本地运行

在项目根目录执行：

```bash
python3 -m http.server 8000
```

打开：

- [http://localhost:8000/public/index.html](http://localhost:8000/public/index.html)

## 路由

- `#/browse` 检索浏览（默认）
- `#/root/:id` 词根详情
- `#/flashcard` 闪卡训练
- `#/quiz` 选择题训练
- `#/stats` 学习统计

## localStorage 键

- `xdf.progress.v1`
  - 词条状态：`new | learning | mastered`
  - 闪卡统计：`shown / remembered / again`
- `xdf.quiz.v1`
  - 选择题：`total / correct / byEntry`
- `xdf.settings.v1`
  - 设置：`dailyGoal / trainingFilter`

## 进度备份与恢复

在 `#/stats` 页面可直接：

- 点击“导出进度(JSON)”下载备份
- 选择备份文件后点击“导入并恢复”

备份 JSON 结构示例：

```json
{
  "version": 1,
  "exportedAt": "2026-02-24T00:00:00.000Z",
  "progress": {},
  "quiz": {},
  "settings": {}
}
```

## 数据说明（roots.json）

顶层：

- `meta.sourceFile`
- `meta.generatedAt`
- `meta.entryCount`
- `meta.exampleCount`
- `entries[]`

`entries[]` 关键字段：

- `id`
- `type` (`prefix|suffix|root`)
- `root`
- `meaningZh`
- `section`
- `aliases[]`
- `examples[]`（`word/decomposition/explanationZh/rawLine`）
- `tags[]`
- `confidence`
