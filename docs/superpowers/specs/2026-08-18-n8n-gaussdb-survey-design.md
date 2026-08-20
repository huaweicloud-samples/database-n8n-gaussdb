# n8n 适配 GaussDB 调研方案设计

> 日期：2026-08-18
> 仓库：n8n-stable（v2.34.6，monorepo，Node ≥22.22，pnpm 10.32.1）
> 目标数据库：GaussDB 商用版 V2.0-26.861.0（Kernel 507，O模式，enable_vectordb=on）
> 文档源：`D:\workplace\code\dify\survey\gaussdb-doc\`（CHM 解压，14049 个 HTML，GB18030 编码）
> 参考范式：`D:\workplace\code\dify\survey\`（dify 已完成的 GaussDB 适配工作区）

## Context

参照 dify/survey 的方式，对 n8n 做 GaussDB 数据库及向量数据库能力适配的**调研**。dify survey 已产出完整链（调研报告 → 改造方案 → 设计 spec → 实施 plan → 实验步骤 → 交付方案），本次 n8n 任务**只到调研报告**，覆盖三个维度（关系型主库 / 向量节点 / 数据库节点）摸清可行性、改造点与风险，范围取舍（做哪些维度）留到后续 spec 阶段。

### 使用场景与优先级（核心）

使用场景：**智数查询、RAG 这类场景支持 GaussDB 作为存储数据库**——即用户在 n8n workflow 里把 GaussDB 当数据源/向量库用，**不是让 n8n 自身跑在 GaussDB 上**。据此定优先级：

- **P0**：维度 C（GaussDB 数据库节点）+ 维度 B（GaussDB 向量节点）——直接服务客户场景，调研报告重点
- **P2**：维度 A（n8n 主库跑在 GaussDB）——非本次目标，报告里简化为"仅作记录"，不展开改造点
- 主库随附的 Agent 记忆表随之降级（仅在 A 做时相关，本次略过）

### dify survey 方法论（本次对标）

产出链：调研报告 → 改造方案 → 设计 spec（`docs/superpowers/specs/`）→ 实施 plan（`docs/superpowers/plans/`）→ 实验步骤（`pyexp/` 探针+验证脚本+日志）→ 交付方案。每个产出物都有实测验证支撑（G3/G4/G9/L10 等实验编号回填进报告）。

### 已确认的关键前提

| 项 | 值 | 来源 |
|---|---|---|
| n8n 版本 | 2.34.6 | `package.json` |
| GaussDB 实例 | 121.37.186.131:19995（Kernel 507 / O模式 / enable_vectordb=on） | dify survey 实测记录 |
| 实例归属 | **与 dify survey 同一实例** | 用户确认 |
| 实测可用性 | **有实例，可实测**（写 pyexp 探针） | 用户确认 |
| 推进方式 | 方案 2：三维度均衡并行（静态分析 + 并行实测），按优先级排探针 | 用户确认 |
| 实例形态 | **集中式**（当前已有实例为集中式，非分布式） | 用户确认 |
| B 维度维度范围 | **覆盖 ≤4096 维（含 GsDiskANN+PQ）** | 用户确认 |
| 调研重心 | **C+B 为主（P0），A 简化记录（P2，非本次目标）** | 用户确认 |
| 产出边界 | **只到调研报告**，范围取舍留 spec 阶段 | 用户确认（选 D） |

> **实例形态澄清**：dify survey 记该实例"维度上限 1024"，但 dify 未测 GsDiskANN+PQ 路径。若该实例实为集中式，则 1024 可能只是 GsIVFFLAT/GsDiskANN（无 PQ）的上限，**集中式 + GsDiskANN + PQ 理论可达 4096**（chm 约束）。n8n 调研需在 `exp_dim_centralized.ts` 重点实测 PQ 路径能否跑通 4096 维。

### dify 已实测确认、n8n 可复用的通用结论

| 通用结论 | dify 实验编号 | 对 n8n 的适用性 |
|---|---|---|
| 开源 psycopg2-binary 2.9.12 直连 GaussDB Kernel 507 成功 | G3 | **不适用**——n8n 用 node `pg` / `pg-promise` / TypeORM postgres 驱动（非 psycopg2），需单独实测 |
| opengauss-sqlalchemy 方言 dialect.name="opengauss" | G4 | **不适用**——n8n 用 TypeORM，无 opengauss 方言包 |
| floatvector/GsIVFFLAT/`<+>` 向量 API 全链路（建表/插入/索引/检索/score/UPDATE/DELETE） | exp_vector_crud | **适用**——向量 SQL 与客户端语言无关，n8n 向量节点用同样的 SQL |
| pgvector 零命中（`vector`类型/HNSW/`<=>` 不兼容） | dify 全文扫描 | **适用**——n8n PGVector 节点不能直接指向 GaussDB，需自建节点 |
| 维度上限：分布式 1024（GsIVFFLAT/GsDiskANN/PQ 均 1024，建表硬限） | L10 + chm | **适用**（分布式形态） |
| 维度上限：集中式 GsDiskANN+PQ 可 4096 | chm 分布式约束 | **适用**（集中式形态，dify 未实测，n8n 需补测） |
| `<+>` 返回余弦距离 [0,2]，score = 1 - distance | exp_vector_crud | **适用** |
| 仅 `ORDER BY col <op> vector LIMIT k` 走向量索引 | chm + exp_vector_crud | **适用** |
| O模式（A模式）：空串→NULL、dual/sysdate/ROWNUM、VARCHAR 按字节计数 | dify 实测 | **适用** |
| JSONB：`->`/`->>`可用，`#>>`不可用(O模式)，GIN不支持(ustore) | dify 实测 | **部分适用**——n8n 用 TypeORM json 列，映射类型不同，需补测 |
| 客户端工具叫 gsql（非 psql） | chm | 适用 |

## n8n 三维度架构（探索确认）

n8n 的"数据库与向量"是三个正交维度，加一个主库随附项：

### 维度 A — 关系型主库（n8n 自身元数据）【P2 · 非本次目标，仅记录】

让 n8n 自身能跑在 GaussDB 上。**本次使用场景不涉及（客户场景是 GaussDB 作存储数据库，不是 n8n 自身元数据库）**，此章节仅作记录，不展开改造点，不排实测探针。

- **DB_TYPE 枚举**：`packages/@n8n/config/src/configs/database.config.ts:140` —— `z.enum(['sqlite', 'postgresdb'])`，只支持两种，无 MySQL。
- **DataSource 选项切换**：`packages/@n8n/db/src/connection/db-connection-options.ts:34-44` —— switch(dbType)，default 分支抛 `UserError('Database type currently not supported')`。
- **DbConnection 服务**：`packages/@n8n/db/src/connection/db-connection.ts:28-51` —— `new DataSource(options)`，注入 DI 容器。
- **迁移机制**：`packages/@n8n/db/src/migrations/`，分 `common/`（两库通用）+ `postgresdb/`（PG 专属）+ `sqlite/`（专属），用 DSL（`migrations/dsl/`）链式构造。
- **迁移锁**：`db-connection.ts:107-133` 的 `migrateWithAdvisoryLock`，用 `DbLockService.withLock(DbLock.MIGRATIONS)`，subKey 按 schema:entityPrefix SHA-256 哈希——依赖 Postgres advisory lock（`pg_advisory_lock`）。
- **ORM**：`@n8n/typeorm`（n8n 自己 fork 的 TypeORM，非上游 npm 包）。
- **CLI 启动**：`packages/cli/src/commands/base-command.ts:155-175` —— `dbConnection.init()` → `migrate()`。

**A 维度最大未知（dify 完全没碰过）**：TypeORM 内置 postgres 驱动（基于 node `pg`）能否连 GaussDB + 跑迁移。dify 用 SQLAlchemy 有 opengauss-sqlalchemy 现成方言包；**TypeORM 生态无 GaussDB/opengauss 方言包**。dify 调研时发现过"SQLAlchemy PG dialect 解析 GaussDB version 字符串失败"的坑，node `pg`/TypeORM 是否有类似版本解析坑，是 A 维度生死线。

**A 维度结论走向（由实测决定）**：
- 乐观：TypeORM postgres 驱动能连 + 跑迁移 → 结论="改 DB_TYPE 枚举 + 加 gaussdb 分支 + 验证迁移"，类似 dify 轻量
- 悲观：驱动/方言有坑 → 结论="需 fork @n8n/typeorm 加驱动/方言，工作量大，建议降级为仅 B/C 维度"

### 维度 B — 向量节点（用户级 RAG）【P0 · 调研重点】

让用户在 workflow 里做 GaussDB 向量检索（RAG）。**本次使用场景核心之一**。

- **现状**：`packages/@n8n/nodes-langchain/nodes/vector_store/VectorStorePGVector/` —— 用 LangChain `PGVectorStore`，连用户自己的 Postgres（需 pgvector 扩展），默认表 `n8n_vectors`。
- **PGVector 节点机制**：`VectorStorePGVector.node.ts:1-5` import `@langchain/community/vectorstores/pgstores/pgvector`；`:7-8` 复用 nodes-base Postgres 节点的 `configurePostgres`；`:187-212` `ExtendedPGVectorStore extends PGVectorStore`；`:214-230` 通过 `createVectorStoreNode({...})` 工厂注册。
- **VectorStore 工厂**：`packages/@n8n/ai-utilities/src/utils/vector-store/createVectorStoreNode/createVectorStoreNode.ts:50-53` —— 所有向量节点经此工厂生成，支持 5 种 mode（insert/load/retrieve/retrieve-as-tool/update）。
- **不可复用**：GaussDB 向量是 legacy API（floatvector/GsIVFFLAT/`<+>`），**不兼容 pgvector**（无 HNSW、无 `vector` 类型、无 `<=>`）。n8n 现有 PGVector 节点不能直接指向 GaussDB，需自建 GaussDB 向量节点（参考 PGVector 节点结构 + createVectorStoreNode 工厂，改 SQL）。

**B 维度向量 SQL 适配（复用 dify 实测，与客户端语言无关）**：

| 维度 | PGVector 节点（现状） | GaussDB 向量节点（适配） | 依据 |
|---|---|---|---|
| 建表列类型 | `embedding vector({dim})` | `embedding floatvector({dim})` | floatvector 类型 |
| 索引（≤1024维） | `USING hnsw (embedding vector_cosine_ops) WITH(m=16,ef_construction=64)` | `USING GSIVFFLAT(embedding cosine) WITH(IVF_NLIST=256)` | GsIVFFLAT 语法 |
| 索引（>1024维，集中式） | 无 | `USING GsDiskANN(embedding cosine) WITH(pq_nseg=,pq_nclus=16,enable_pq=true,subgraph_count=1,enable_vector_copy=false)` | GsDiskANN+PQ |
| 检索余弦 | `embedding <=> %s AS distance` | `embedding <+> %s AS distance` | `<+>` 余弦距离 |
| score | `1 - distance` | 相同（`<+>` 是余弦距离） | exp_vector_crud |
| SET 调优 | `SET hnsw_earlystop_threshold` | `SET gsivfflat_probes = 25`（IVF_NLIST ~10%） | GUC |

**B 维度索引选择逻辑（维度 + 形态双因素）**：

> 当前已有实例为**集中式**，实测以集中式为准。分布式仅作 chm 约束陈述（建表维度硬限 1024），若无分布式实例则标"待测"。

| 维度 | 形态 | 推荐索引 | PQ | 说明 |
|---|---|---|---|---|
| ≤1024 | 任一 | GsIVFFLAT（默认） | 否 | 简单，已实测 |
| ≤1024 | 大数据量（>200万） | GsDiskANN | 可选 | — |
| 1024<dim≤4096 | **集中式** | **GsDiskANN+PQ（必须）** | **是** | GsIVFFLAT 不支持>1024；**本次重点实测 PQ 路径能否跑通 4096** |
| 1024<dim≤4096 | **分布式** | **不支持** | — | 建表硬限 1024，代码层报错引导用户选 ≤1024 维模型或换集中式 |

**GsDiskANN+PQ 参数算法（`pq_nseg` 按维度整除，dify 描述未实测，n8n 需补测）**：
- `enable_pq=true, quantization_type='pq', subgraph_count=1, enable_vector_copy=false`（>1024 维必须）
- `pq_nseg`：须整除维度。`<512 维 → =维度`；`512~1024 → =维度/2`；`>1024 → 取能整除的合适值`
- `pq_nclus=16`（1024 维内推荐 16）
- 例：768→384，1536→96，3072→96/192，4096→256

### 维度 C — 数据库节点（用户操作外部库）【P0 · 调研重点】

让用户在 workflow 里读写 GaussDB（SQL 增删改查）。**本次使用场景核心之一（智数查询）**。

- **现状**：`packages/nodes-base/nodes/Postgres/v2/` —— Postgres v2 节点，驱动 `pg-promise`（`transport/index.ts:10`），`configurePostgres`（:114-206）核心入口。
- **凭据**：`packages/nodes-base/credentials/Postgres.credentials.ts` —— host/port/database/user/password/maxConnections/ssl + sshTunnel。
- **CrateDb 先例**：`packages/nodes-base/nodes/CrateDb/CrateDb.node.ts:8-19` —— CrateDB 走 PG 协议，直接 `import pgPromise` + 复用 `Postgres/v1/genericFunctions`（pgInsert/pgQueryV2/pgUpdate），`sqlDialect: 'PostgreSQL'`。
- **适配模式**：参考 CrateDb，新增 `packages/nodes-base/nodes/GaussDb/` 节点 + `credentials/GaussDb.credentials.ts`，用 `pg-promise` 连 GaussDB（PG 线协议），复用 Postgres v1 通用函数。`sqlDialect: 'PostgreSQL'`。
- **生死线**：`pg-promise` 能否连 GaussDB（dify 测的是 psycopg2，pg-promise 未测）。

### 主库随附 — Agent 记忆表（非独立维度）【P2 · 随 A 降级，本次略过】

- **存储位置**：随 n8n 主库迁移，不是独立库。`packages/cli/src/modules/instance-ai/storage/typeorm-agent-memory.ts` —— 用 TypeORM 操作主库 DataSource（`:29` `import { In, LessThan, Like } from '@n8n/typeorm'`），通过 `InstanceAiMessageRepository` 等 repository 读写。
- **对应表**（`packages/@n8n/db/src/migrations/common/1784000000009-CreateAgentMemoryEntryTables.ts`，已注册进 postgresdb/sqlite 迁移）：
  - `agents_memory_entries` —— `:20` `embedding` 列用 `.json` 类型存向量（**不是 pgvector**），`:21` `metadata` 也是 json
  - `agents_memory_entry_locks` / `agents_memory_entry_sources` / `agents_memory_entry_cursors`
- **内存实现**：`packages/@n8n/agents/src/runtime/memory/memory-store.ts` 的 `InMemoryMemory`（开发/测试用，进程重启即丢）。
- **向量检索**：应用层 `packages/@n8n/agents/src/runtime/memory/episodic-memory.ts` 的 `rankEpisodicMemoryEntries` + RRF 混合检索，数据库只做存储。
- **关键结论**：agent 记忆**不依赖 pgvector**，GaussDB 的 floatvector 向量能力与此无关。随 A 维度一起适配，唯一风险点是 JSON 列在 GaussDB O模式下的 TypeORM 映射。

## 调研报告章节结构

| 章 | 内容 | 优先级 | 复用 dify |
|---|---|---|---|
| 一、调研背景 | n8n 2.34.6 + GaussDB V2.0-26.861.0，三维度 + 主库随附定义 + 使用场景 | — | — |
| 二、结论速览 | 三维度 go/no-go + 主库随附 一表（标注 P0/P2） | — | — |
| 三、数据库节点（C） | Postgres v2/pg-promise/CrateDb 复用模式/GaussDB 节点设计 | **P0** | 否（n8n 特有） |
| 四、向量节点（B） | PGVector 节点机制/createVectorStoreNode 工厂/floatvector 适配/集中式索引选择/PQ 算法 | **P0** | 部分（向量 SQL 适配复用，节点机制不同） |
| 五、驱动与兼容性 | node pg / pg-promise 两套 PG 客户端（C/B 共用） | **P0** | 部分（dify 测 psycopg2，node 系补测） |
| 六、关系型主库（A） | DB_TYPE 枚举/TypeORM 驱动——**简化记录，非本次目标** | P2 | 否（TypeORM vs SQLAlchemy） |
| 七、主库随附：Agent 记忆表 | typeorm-agent-memory/JSON 列——**随 A 降级，略过** | P2 | 否（n8n 特有） |
| 八、配置位置索引 | 节点注册/凭据/PostgresConfig 等关键文件 | — | — |
| 九、适配建议 | C+B 重点建议 + A 留档 + 风险矩阵 + 范围取舍提示 | — | — |
| 十、证据索引 | 源码文件:行号 / chm 文档 / 实验编号 | — | — |

## 实测计划（pyexp 探针清单）

存放位置：`D:\workplace\code\n8n-stable\survey\pyexp\`（独立 TS 脚本，方案 a，与 dify `pyexp/` 同构）。每探针对应一实验编号，结论回填进报告证据索引。按优先级排：P0（C+B）先跑，P2（A）可选。

| 探针 | 验证什么 | 维度 | 优先级 | 复用 dify | 预期 go/no-go |
|---|---|---|---|---|---|
| `exp_pg_promise.ts` | `pg-promise` 连 GaussDB + 执行查询（C/B 共用驱动） | C 生死线 | **P0** | 否（dify 测 psycopg2） | 查询成功→C/B 可行 |
| `exp_vector_crud.ts` | floatvector 建表/插入/GsIVFFLAT/`<+>` 检索/score/UPDATE/DELETE 全链路 | B | **P0** | 是（dify 已测通，重跑确认同一实例） | 已知 go |
| `exp_pgvector_compat.ts` | 验证 GaussDB 是否兼容 pgvector（`vector`/HNSW/`<=>`） | B 决策 | **P0** | 是（dify 已测零命中） | 已知 no-go→需自建节点 |
| `exp_dim_centralized.ts` | **集中式**实例维度上限：GsIVFFLAT/GsDiskANN（无PQ）上限 + GsDiskANN+PQ 能否 4096 | B 约束 | **P0** | 否（dify 未测 PQ 路径） | 预期无PQ 1024 / +PQ 4096 |
| `exp_pq_index.ts` | 1024<dim≤4096 维 GsDiskANN+PQ 建索引+检索全链路（`pq_nseg` 整除算法实测：1536/3072/4096） | B | **P0** | 否（dify 只描述未实测） | go→PQ 路径可用 |
| `exp_pg_driver.ts` | node `pg` 驱动直连 GaussDB（LangChain PGVectorStore 底层用 pg） | B 辅助 | P1 | 否 | 连上→go |
| `exp_typeorm_migrate.ts` | `@n8n/typeorm` postgres 驱动连 GaussDB + fresh 迁移建表 | A | P2（可选） | 否 | 仅 A 启动时跑 |
| `exp_json_column.ts` | TypeORM `.json` 列在 O模式映射 + CRUD + `->`/`->>` | A/Agent记忆 | P2（可选） | 部分 | 仅 A 启动时跑 |
| `exp_advisory_lock.ts` | `pg_advisory_lock`（n8n 迁移锁）在 GaussDB 是否可用 | A 迁移机制 | P2（可选） | 否 | 仅 A 启动时跑 |
| `exp_timestamp_tz.ts` | `timestampTimezone(3)` 列在 O模式行为 | A/Agent记忆 | P2（可选） | 否 | 仅 A 启动时跑 |

**形态实测说明**：当前已有实例为**集中式**，`exp_dim_centralized.ts` + `exp_pq_index.ts` 重点实测集中式 PQ 路径能否跑通 4096 维（dify 未测的关键缺口）。分布式形态若无实例，据 chm 文档约束陈述"建表维度硬限 1024"，标"待测"。

**A 维度探针降级**：A 为 P2 非本次目标，`exp_typeorm_migrate.ts` / `exp_json_column.ts` / `exp_advisory_lock.ts` / `exp_timestamp_tz.ts` 标可选，仅当后续启动 A 维度时跑。本次调研报告 A 章节据源码静态分析 + chm 陈述，不依赖实测。

## 产出物

| 产出物 | 路径 | 形态 | 对标 dify |
|---|---|---|---|
| 调研报告 | `survey/n8n-gaussdb-调研报告.md` | 单份 Markdown，十章结构 | `dify-gaussdb-调研报告.md` |
| 探针脚本 | `survey/pyexp/*.ts` | 独立 TS 脚本，每探针对应实验编号 | `pyexp/*.py` |
| 探针日志 | `survey/pyexp/*.log` | 实测输出，回填进报告证据索引 | `pyexp/*.log` |

存放根目录：`D:\workplace\code\n8n-stable\survey\`（n8n 仓库根下新建，与 `D:\workplace\code\dify\survey\` 同构）。

## 调研报告结论形态

C+B（P0）各自给出 go/no-go + 改造点概要 + 风险等级，**不展开实现细节**（那是后续改造方案/spec 的事）。A（P2）仅作记录性陈述（源码静态分析 + chm），不给 go/no-go。每个结论标注证据来源（源码文件:行号 / chm 文档 / 实验编号）。含"证据索引"章。

C+B 结论由 P0 探针实测驱动；A 不依赖本次实测。

## 不在本调研范围

- 改造方案（三维度具体改哪些文件、怎么改）—— 留后续改造方案文档
- 设计 spec / 实施 plan —— 留 `docs/superpowers/specs/` + `plans/`
- 交付方案 / Docker 镜像 / 部署文档 —— 留交付阶段
- 范围取舍（A/B/C 做哪些）—— 留 spec 阶段，本次三维度全覆盖摸清

## 风险与降级

| 风险 | 降级方案 |
|---|---|
| pg-promise 连不上 GaussDB（C/B 生死线失败） | C/B 维度结论标 no-go，报告聚焦诊断原因（PG 协议握手/认证/版本），不展开节点设计 |
| 集中式 GsDiskANN+PQ 跑不通 4096 维 | B 维度降为"≤1024 维 GsIVFFLAT 可用，>1024 维待 GaussDB 侧确认"，如实记录实测结果 |
| `@n8n/typeorm` workspace 包在独立 TS 脚本中依赖解析困难 | 探针改放 `packages/@n8n/db` 下临时文件（方案 b），或 `pnpm pack` 引用 dist |
| GsDiskANN+PQ 参数（pq_nseg）计算不当 | 按维度整除规则，exp_pq_index 实测校验多个维度（1536/3072/4096） |
| pgvector 兼容性误判 | exp_pgvector_compat 实测 `vector` 类型/HNSW/`<=>` 三项，确认不兼容 |
| A 维度（P2）实测未跑 | A 章节据源码静态分析 + chm 陈述，明确标"非本次目标，结论待 A 启动时实测补强" |
