# 原文取证链路评测

[English](policy-retrieval-evaluation.md) | 中文

2026-10-15 的测量使用本地只读语料库，共 494 份文档、61,455 个正文单元，环境为 Windows、Node.js 24.14.0。候选链路和查询规划在本地运行。混合检索通过临时本地 SSH 转发调用 DGX 现有 Embedding 和 Chroma 服务，不在 DGX 安装文件或容器。两种实现使用同一个 SQLite 快照和已有向量集合。

## 验收与结果

| 检查 | 修改前 | 修改后 |
| --- | --- | --- |
| 既有 90 题预期标题/有无结果检查 | 72/90 | 72/90 |
| 6 个实际问题的混合召回 | 5/6 | 6/6 |
| 96 题的正文、标题、日期、文号和行号完整性 | 96/96 | 96/96 |
| 本地观测的混合检索 P95 | 2003 ms | 760 ms |

6 个实际问题覆盖核安全法概述及第一条、水土保持法概述、养猪场粪污处理、污水超标责任和粪水排河。污水超标责任问题此前耗尽语义预算，未召回预期的水污染防治法；优化后可以召回。测量不包含回答生成。缓存、网络和主机负载会影响耗时；P95 是观测值，不是 DGX 延迟承诺。

既有 90 题使用预期标题和有无结果条件，其中包含向规划、标准询问其不存在的条款、标题别名、无答案和否定前提。剩余 18 个失败案例保留，没有修改预期以提高分数。召回相关文件不等于文件支持问题前提。这组题不能衡量回答准确率或法律判断是否正确。

## 交替顺序的本地耗时对比

以下词法检索在同一台电脑、同一只读文件上运行三轮，每轮交替新旧实现顺序，并预热索引统计。数值为中位数，原文标识和引用完整性保持不变。

| 问题 | 修改前 | 修改后 |
| --- | --- | --- |
| 核安全法第一条 | 2.8 ms | 3.9 ms |
| 养猪场粪污处理 | 358 ms | 246 ms |
| 污水超标责任 | 1669 ms | 469 ms |
| 粪水能否排河 | 500 ms | 297 ms |

BM25 改为先聚合词项并限制候选标识，再加载正文列。原文取证每批 SQL 最多读取 100 个不同单元，拒绝缺失单元、原文哈希不匹配和非法 Unicode 位置。故障测试还覆盖单个向量集合失败、Chroma 伪造文本副本、同一单元重复投票、Embedding 版本不兼容、集合不完整及原子版本选择失败。

## 复现

在仓库根目录执行，并单独准备语料库。评估器只读打开 SQLite，仅向指定路径写报告。`--implementation-root` 可指定保存的旧版源码目录进行对比。`--hybrid-config` 接受包含现有 HybridConfig 端点和候选设置的私有 JSON 文件，不创建或更新向量集合。

```bash
node --experimental-strip-types packages/experimental/environment-policy/eval/run.ts --database data/policy-national-v1.sqlite --output retrieval-report.json
pnpm exec vitest run packages/experimental/environment-policy/tests
python3 -m unittest discover -s packages/experimental/environment-policy/deploy -p 'test_*.py'
```

新版集合构建与原子版本选择使用本地 SQLite 临时库和模拟向量/Embedding API 验证。现有生产集合以 legacy 模式只读查询。完整语料的索引重建、生产版本激活及 DGX 容器部署须在合并后单独验证，本评测没有声称这些步骤已在生产执行，也没有给生成模型的回答质量打分。
