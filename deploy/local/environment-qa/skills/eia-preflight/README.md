# 建设项目环境影响报告预审

打开本地 [3080](http://127.0.0.1:3080/)，新建「环境技能问答」会话，上传 PDF 后询问整份预审或某一专项。例如「请按实际 PDF 页码复核报告中的废水总氮，从输入参数追到排口和汇总表」。

模型按 [SKILL.md](SKILL.md) 中的审核方法阅读报告、选择证据、确定适用口径和算式，并形成结论。[scripts](scripts/) 提供本地工具。

| 工具 | 返回内容 |
| --- | --- |
| `eia_report_open` | PDF 页数、可读性、目录、标题、表号线索和供本次会话使用的 `report_id` |
| `eia_report_evidence` | 按实际页码、页段、章节、表名或关键词读取的原文及表格行 |
| `eia_calculate` | 以十进制运算求给定算式的结果，并保留模型记录的变量单位和来源 |

PDF 上限为 128 MiB、1200 页。工具读取已有文字层，扫描件需要文字版或 OCR。表格按可识别的结构提取，可连同整页原文、续页或脚注一起核对。索引失效时，在同一会话重新打开原件。

按[本地启动说明](../../README.md)启动服务。默认使用 PATH 中的 `python`，可通过 `DSH_EIA_PYTHON` 指定解释器。在仓库根目录运行以下命令测试本地解析。

```powershell
python -m pip install -r deploy/local/environment-qa/skills/eia-preflight/scripts/requirements.txt
python -X utf8 deploy/local/environment-qa/skills/eia-preflight/scripts/review.py '报告.pdf'
python -B -m unittest discover -s deploy/local/environment-qa/skills/eia-preflight/scripts -p 'test_*.py'
```
