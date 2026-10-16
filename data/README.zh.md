# 环境政策索引构建资料

[English](README.md) | 中文

`policy-national-v1.sqlite` 是生成的国家级环境政策原文数据库。A、B 两种部署均使用 DGX 上的数据库；本目录用于准备构建产物，不是第三种 Harness 部署方式。数据库体积较大，已加入 Git 忽略，不随代码上传。

构建脚本默认输出到：

```text
data/policy-national-v1.sqlite
```

在仓库根目录准备 Markdown 原文、源文件清单、元数据和 description 等输入后运行：

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

脚本默认将 SQLite 和清单写入本目录。原始语料和生成文件不提交到 Git。构建完成后，按[检索部署指南](../packages/experimental/environment-policy/deploy/README.zh.md)将 SQLite 快照与匹配的向量索引成套校验、发布到 DGX；更新数据库时也要同步[可视化配置](../deploy/db-viewers/README.zh.md)所指向的快照。
