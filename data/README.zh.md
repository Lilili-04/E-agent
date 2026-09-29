# 本地环境政策索引

`policy-national-v1.sqlite` 是本地 DSH preset 使用的国家级环境政策法规索引。数据库属于体积较大的生成语料产物，已加入 Git 忽略，不会随源代码上传。

数据库应放在：

```text
data/policy-national-v1.sqlite
```

请从仓库根目录启动 DSH，使 preset 中的相对路径能够正确解析。需要重新构建时，请准备清单、元数据、description 和原始语料，并运行：

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

构建脚本默认把 SQLite 索引和清单写入本目录。原始政策语料和输入文件属于本地部署资料，不需要提交到代码仓库。
