# n8n-gaussdb

[![Status](https://img.shields.io/badge/Status-Incubating-blue)]()
[![Huawei Cloud](https://img.shields.io/badge/Huawei%20Cloud-Samples-red)]()
[![n8n](https://img.shields.io/badge/n8n-2.34.6-blue)]()
[![GaussDB](https://img.shields.io/badge/GaussDB-O模式-orange)]()

GaussDB 生态建设：n8n 适配兼容 GaussDB（数据库节点 + 向量库）。

## Overview

本项目将 [n8n](https://github.com/n8n-io/n8n) 2.34.6 适配到华为云 GaussDB，让用户在 n8n workflow 中使用 GaussDB 作为存储数据库和向量数据库：

- **数据库节点（C 维度）**：新增 GaussDb 节点（6 operation：executeQuery/insert/update/select/upsert/deleteTable），用户在 workflow 里对 GaussDB 做 SQL 增删改查（智数查询场景）
- **向量节点（B 维度）**：新增 VectorStoreGaussDB + ChatHubVectorStoreGaussDB 节点，基于 GaussDB 原生向量（floatvector + GsIVFFLAT/GsDiskANN 索引）做 RAG 向量存储/检索
- **O模式适配**：GaussDB O模式（DBCOMPATIBILITY='A'）完整适配——upsert 用 MERGE INTO（O模式无 ON CONFLICT）、id 用 varchar(36)+应用层 uuid（无 gen_random_uuid）、空串→NULL、jsonb 操作符
- **自动探测不抛报错**：节点自动探测 GaussDB 形态（集中式/分布式）+ 维度上限，自动选索引策略，仅物理硬限给友好提示

> **范围说明**：本适配覆盖客户场景（workflow 里用 GaussDB 做智数查询/RAG）。n8n 自身元数据跑 GaussDB（A 维度）为 P2 未实现。

> ⚠️ **部署/使用/二次开发前必读 [注意事项](delivery/注意事项.md)**：O模式适配（MERGE INTO/varchar uuid/空串）、enable_vectordb 实例级开启、pgvector 不兼容、维度限制、密码特殊字符、ErrorOptions 构建修复等关键约束。

## 快速部署

**部署目录结构**（`.env` 必须和启动配置在同一目录）：

```
/opt/n8n-gaussdb/                    ← 部署目录
├── n8nio-n8n-gaussdb.tar            ← 镜像（docker load 后可删）
├── .env                             ← 从 .env.example 复制并修改
└── tests/                           ← 测试脚本（从 delivery/tests/ 复制，可选）
```

```bash
# 1. 准备部署目录
mkdir -p /opt/n8n-gaussdb && cd /opt/n8n-gaussdb

# 2. 下载镜像 tar 并加载（从 Release 下载）
docker load -i n8nio-n8n-gaussdb.tar

# 3. 从交付包复制配置模板（delivery/ 内容已随仓库 clone 到本地）
cp delivery/.env.example .env

# 4. 编辑 .env，填入 n8n 配置（N8N_ENCRYPTION_KEY 等，GaussDB 连接在 UI 配）
vi .env

# 5. 启动
docker run -d --name n8n-gaussdb \
  -p 5678:5678 \
  --env-file .env \
  -v n8n_data:/home/node/.n8n \
  n8nio/n8n:gaussdb

# 6. 访问 http://localhost:5678，在 UI 配置 GaussDB 凭据（见配置文档）
```

> 也支持源码直接启动：`pnpm install && pnpm build && pnpm start`。详见 [delivery/实施部署交付文档.md](delivery/实施部署交付文档.md)。

## 数据库连接配置

GaussDB 连接分两个层面（详见 [delivery/配置文档.md](delivery/配置文档.md)）：

1. **n8n 自身元数据库**（存 workflow/credentials）：通过环境变量 `DB_TYPE` + `DB_POSTGRESDB_*`（默认 sqlite，本次适配不涉及 GaussDB 作自身库）
2. **workflow 里连 GaussDB**（C 智数查询 + B 向量）：在 n8n UI → Credentials 配置（非环境变量）：
   - GaussDb 节点：选 "GaussDB" 凭据，填 host/port/database/user/password/ssl
   - 向量节点：选 "Postgres" 凭据（GaussDB PG 协议兼容），指向 GaussDB

## 测试

测试方法见 [delivery/测试指南.md](delivery/测试指南.md)，含 5 层测试：
- L1 健康检查
- L2 GaussDB 连通性 + 节点加载验证
- L3 数据库节点 6 operation 端到端（C 维度）
- L4 向量节点全链路（B 维度：floatvector/GsIVFFLAT/GsDiskANN+PQ）
- L5 边界 + 回归（SQL 注入/特殊字符/O模式/维度边界/Postgres 节点不回归）

测试脚本在 [delivery/tests/](delivery/tests/)（自动从 `.env.test` 读配置，无需手改），含一键 `run_all.sh`。

## 适配改造说明

### 数据库节点适配（C 维度）
- 新增 `packages/nodes-base/nodes/GaussDb/`（Postgres v2 多文件结构，6 operation）
- 复用 Postgres v1 genericFunctions（pgInsert/pgQueryV2/pgUpdate）
- `configureGaussDb`（nodeType:'gaussDb'，不复用 configurePostgres 避免池冲突）
- 凭据 `gaussDbApi`（lint 规则要求 Api 后缀，不在豁免列表）
- upsert 用 MERGE INTO（O模式不支持 ON CONFLICT）

### 向量节点适配（B 维度）
- 新增 `GaussDBVectorStore extends Langchain VectorStore`（不 extends PGVectorStore，pgvector SQL 不可复用）
- floatvector/GsIVFFLAT/GsDiskANN+PQ，距离算子 `<+>`，score = 1 - distance
- id 用 varchar(36) + 应用层 uuid（O模式无 gen_random_uuid）
- 形态自动探测：datcompatibility A=集中式/ORA=分布式 + 维度上限探测
- pq_nseg 整除算法：>1024 维 GsDiskANN+PQ，pq_nseg 须整除维度

### 维度限制

| 索引类型 | 集中式 | 分布式 |
|---|---|---|
| GsIVFFLAT | ≤1024 维 | ≤1024 维 |
| GsDiskANN（无PQ） | ≤1024 维 | ≤1024 维 |
| GsDiskANN+PQ | ≤4096 维 | ≤1024 维（硬限） |

## 目录结构

```
├── packages/nodes-base/nodes/GaussDb/         # C 维度：GaussDb 数据库节点（30 文件）
├── packages/@n8n/nodes-langchain/
│   └── nodes/vector_store/
│       ├── VectorStoreGaussDB/                # B 维度：标准向量节点
│       └── ChatHubVectorStoreGaussDB/         # B 维度：ChatHub 向量节点
├── packages/@n8n/errors/src/types.ts          # pre-existing 修复（ErrorOptions）
├── delivery/                                  # 交付包
│   ├── .env.example                           # n8n 配置模板
│   ├── 配置文档.md                            # 数据库连接配置
│   ├── 实施部署交付文档.md                    # 部署步骤
│   ├── 测试指南.md                            # 测试方法
│   ├── 注意事项.md                            # 部署/使用/二次开发避坑必读
│   └── tests/                                 # 测试脚本（连通/C维度/向量 + run_all.sh）
└── survey/                                    # 调研产出（不入 git，仅内部参考）
└── survey/                                    # 调研产出（不入 git，仅内部参考）
    ├── n8n-gaussdb-调研报告.md
    └── pyexp/                                 # 探针脚本
```

## GaussDB 前置条件

| 条件 | 要求 | 检查 |
|---|---|---|
| 版本 | GaussDB Kernel 507+ | `SELECT version()` |
| 兼容模式 | O模式（datcompatibility='A'） | `SELECT datcompatibility FROM pg_database WHERE datname=current_database()` |
| 向量开关 | enable_vectordb=on | `SHOW enable_vectordb`（POSTMASTER 级，需实例配置+重启） |
| maintenance_work_mem | ≥512MB（建向量索引） | 节点会话级 SET，无需改实例 |
| 形态 | 集中式支持 ≤4096 维；分布式 ≤1024 维 | 节点自动探测 |

## License

本项目基于 [n8n](https://github.com/n8n-io/n8n)（Sustainable Use License）改编。
