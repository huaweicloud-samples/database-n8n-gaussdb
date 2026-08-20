# n8n 适配 GaussDB — C+B 改造方案设计

> 日期：2026-08-19
> 仓库：n8n-stable v2.34.6
> 目标数据库：GaussDB Kernel 507.0.0（集中式 / O模式 / enable_vectordb=on）
> 前置调研：`survey/n8n-gaussdb-调研报告.md`（7 个探针 N-EXP-01~07 实测通过）
> 产出深度：**设计 spec**（不写实现代码，用户审阅后决定是否进实现）

## Context

调研阶段确认 C+B 两维度 GO（`survey/n8n-gaussdb-调研报告.md`）。本 spec 把调研结论转化为可执行的改造设计。

**核心要求（全场景覆盖原则）**：客户使用 n8n 的场景中，凡是 workflow 里会用到数据库/向量数据库的地方，都要支持 GaussDB 作为存储选项。n8n 里所有"会连数据库"的场景已系统梳理，共三类：
1. 用户操作外部数据库的数据节点（C 维度）—— 本 spec 覆盖
2. 用户级 RAG 向量存储（B 维度）—— 本 spec 覆盖
3. n8n 自身元数据库（A 维度，P2）—— 非客户场景，不在本 spec

其他数据库节点（MySql/Oracle/MongoDb/Redis 等）对应各自产品，与 GaussDB 无关。GaussDB 作为 PG 协议兼容关系库 + 内置 vectordb 向量库，C+B 已全覆盖客户需求。

## 已确认的关键前提

| 项 | 值 | 来源 |
|---|---|---|
| n8n 版本 | 2.34.6 | package.json |
| GaussDB 实例 | localhost:5432，Kernel 507.0.0 build 19fa72ae | N-EXP-02 |
| 实例形态 | **集中式** | 用户确认 |
| 兼容模式 | **O模式（datcompatibility=A，Oracle 兼容）** | N-EXP-02/07 |
| enable_vectordb | on（POSTMASTER 级，需实例配置+重启） | N-EXP-02 |
| pg-promise 连通 | ✅ | N-EXP-02 |
| node pg 连通 | ✅（无版本解析坑） | N-EXP-01 |
| floatvector 向量全链路 | ✅ | N-EXP-03 |
| pgvector 不兼容 | ✅（vector/HNSW/`<=>` 全 absent） | N-EXP-04 |
| 维度上限 | GsIVFFLAT/GsDiskANN(无PQ) 1024；GsDiskANN+PQ 集中式 4096 | N-EXP-05/06 |
| O模式 UUID | gen_random_uuid()/uuid_generate_v4() **不存在** | N-EXP-07 |
| O模式 jsonb | `->`/`->>`/`?|` 可用；空串→NULL（顶层列）；RETURNING 可用 | N-EXP-07 |
| C operation 范围 | **6 个全量对齐 Postgres v2** | 用户确认 |
| B 节点范围 | **标准版 + ChatHub 版** | 用户确认 |

## 维度 C — GaussDb 数据库节点【P0】

### 文件结构（参考 Postgres v2 多文件结构，6 operation）

```
packages/nodes-base/nodes/GaussDb/
├── GaussDb.node.ts                    # implements INodeType，execute→router（照 PostgresV2.node.ts:13-28）
├── gaussdb.svg                        # 图标
├── transport/
│   └── index.ts                       # configureGaussDb（内联 pgPromise，nodeType:'gaussDb'）
├── actions/
│   ├── router.ts                      # 操作路由（照 Postgres v2/actions/router.ts:15-64）
│   ├── versionDescription.ts          # 节点描述（credentials/group/version/inputs/outputs）
│   ├── common.descriptions.ts         # 共享字段（schemaRLC/tableRLC）
│   └── database/
│       ├── Database.resource.ts       # 聚合 6 operation（照 Database.resource.ts:19-58）
│       ├── executeQuery.operation.ts  # 复用 pgQueryV2，sqlDialect:'PostgreSQL'
│       ├── insert.operation.ts        # 复用 pgInsert
│       ├── update.operation.ts        # 复用 pgUpdate
│       ├── upsert.operation.ts        # 复用 pgUpdate（ON CONFLICT 模式）
│       ├── select.operation.ts        # 复用 pgQueryV2（SELECT）
│       └── deleteTable.operation.ts   # 复用 pgQueryV2（DELETE/DROP）
├── helpers/
│   └── interfaces.ts                  # GaussDbNodeCredentials 类型（照 PostgresNodeCredentials，精简）
└── methods/
    ├── credentialTest.ts              # gaussDbConnectionTest
    ├── listSearch.ts                  # 表/列列表
    └── loadOptions.ts                 # 动态下拉

packages/nodes-base/credentials/
└── GaussDb.credentials.ts             # name='gaussDb'
```

### GaussDb.node.ts 设计

```ts
export class GaussDb implements INodeType {
  description: INodeTypeDescription;
  constructor(baseDescription: INodeTypeBaseDescription) {
    this.description = { ...baseDescription, ...versionDescription };
  }
  methods = { listSearch, loadOptions, credentialTest };
  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    return await router.call(this);
  }
}
```

### configureGaussDb（transport/index.ts）

**不复用 configurePostgres**（它写死 `nodeType:'postgres'` 池 key + 依赖 SSH 隧道/ConnectionPoolManager）。内联 pgPromise，照 CrateDb :266-282 模式：

```ts
export async function configureGaussDb(this: IExecuteFunctions, credentials, options) {
  const pgp = pgPromise({ noWarnings: true });
  const config = {
    host, port, database, user, password,
    ssl: !['disable', undefined].includes(credentials.ssl),
    sslmode: credentials.ssl || 'disable',
    max: credentials.maxConnections ?? 10,
  };
  const db = pgp(config);
  return { db, pgp };
}
```

### GaussDb.credentials.ts（照 CrateDb 精简版 + Postgres 字段）

| 字段 | type | default | 说明 |
|---|---|---|---|
| host | string | localhost | 必需 |
| database | string | postgres | 必需 |
| user | string | gaussdb | 必需 |
| password | password | '' | 必需 |
| port | number | 8000 | 必需（用户实例填实际端口） |
| ssl | options | disable | allow/disable/require |

name='gaussDb'，displayName='GaussDB'。初版不含 maxConnections/allowUnauthorizedCerts/sshTunnel（后续按需加）。

### operations（复用 Postgres/v1/genericFunctions）

| operation | 复用函数 | 行号 |
|---|---|---|
| executeQuery | pgQueryV2 | genericFunctions.ts:182-281 |
| insert | pgInsert | :291-373 |
| update | pgUpdate | :494-616 |
| upsert | pgUpdate（ON CONFLICT 模式） | :494-616 |
| select | pgQueryV2（SELECT） | :182-281 |
| deleteTable | pgQueryV2（DELETE/DROP） | :182-281 |
| 辅助 | generateReturning/getItemCopy/getItemsCopy | :27-86 |

sqlDialect: 'PostgreSQL'（executeQuery.operation.ts，照 CrateDb :83）。

### 注册（package.json，不动 n8n 主代码）

- credentials 数组加 `"dist/credentials/GaussDb.credentials.js"`
- nodes 数组加 `"dist/nodes/GaussDb/GaussDb.node.js"`

### C 维度 O模式适配（N-EXP-07）

- INSERT 空串→NULL：pgInsert 生成的 SQL 需注意（CrateDb 先例可参考）
- WHERE 判空用 `IS NULL`，不用 `=''`
- RETURNING 可用（insert/update/upsert 可用）
- gen_random_uuid 不可用——若 upsert 用到 id 生成，应用层 uuid()

## 维度 B — GaussDB 向量节点【P0】

### 文件结构（标准版 + ChatHub 版，共用 GaussDBVectorStore）

```
packages/@n8n/nodes-langchain/nodes/vector_store/
├── VectorStoreGaussDB/
│   ├── VectorStoreGaussDB.node.ts    # 标准节点（createVectorStoreNode 工厂）
│   ├── GaussDBVectorStore.ts         # 核心：extends VectorStore，两节点共用
│   └── gaussdb.svg
├── ChatHubVectorStoreGaussDB/
│   └── ChatHubVectorStoreGaussDB.node.ts  # ChatHub 版（复用 GaussDBVectorStore）
└── shared/                            # 已有，ChatHub 共享逻辑（filterChatHubMetadata 等）
```

### GaussDBVectorStore.ts（核心，extends VectorStore，不 extends PGVectorStore）

**为什么 extends VectorStore 不 extends PGVectorStore**：PGVectorStore 底层 SQL 全硬编码 pgvector（`vector`类型/`<=>`/`hnsw`/`CREATE EXTENSION vector`/`gen_random_uuid`，pgvector.cjs:625-640/287-302/732-758），extends 等于重写整个类。

实现 5 个方法：

```ts
export class GaussDBVectorStore extends VectorStore {
  // 状态：pool (pg.Pool), tableName, columnNames, indexType, filter

  async addVectors(vectors, documents) {
    // INSERT，字符串字面量 [v1,v2,...]，应用层 uuid() 生成 id（O模式 gen_random_uuid 不可用）
    // INSERT INTO {table} (id, content, embedding, metadata) VALUES (uuid(), $1, $2::floatvector, $3)
  }

  async similaritySearchVectorWithScore(query, k, filter) {
    // SET gsivfflat_probes=25 (若 ivfflat)
    // SELECT id, content, metadata, embedding <+> $1::floatvector AS distance
    //   FROM {table} WHERE {filterClauses} ORDER BY distance LIMIT $2
    // score = 1 - distance（O模式适配：统一 1-distance，不用 PGVectorStore 的 (2-d)/2）
  }

  async delete({ ids } | { filter }) {
    // DELETE BY id 或 metadata filter（用 ->>/?| 操作符，O模式可用）
  }

  async ensureTable(dimensions) {
    // O模式适配：id 用 varchar(36) 不用 uuid DEFAULT gen_random_uuid()
    // CREATE TABLE {table} (
    //   id varchar(36) PRIMARY KEY,
    //   content text,
    //   embedding floatvector({dim}) NOT NULL,
    //   metadata jsonb
    // )
  }

  async createIndex(dimensions, indexType) {
    // SET maintenance_work_mem='512MB'（带引号，N-EXP-05 实测）
    // 按 indexType + 维度建索引（见索引选择逻辑）
  }

  // buildFilterClauses：复用 PGVectorStore 的逻辑（->>/?| 操作符 O模式可用）
  //   metadata->>'key' = $ / IN / ?| array（pgvector.cjs:470/476/482/503）
}
```

### 索引选择逻辑（自动探测 + 自动选索引，不抛报错）

**设计原则（用户要求）**：分布式/集中式形态与维度限制由节点自动探测适配，尽量不抛报错——客户定位报错费劲。只有维度真正超过数据库物理上限（节点无法变造数据库能力）时才给友好提示。

节点 createIndex 改为**自动探测三步**：

**步骤 1 · 探测形态**（运行时查 DBCOMPATIBILITY，不靠客户选）：
```ts
// 主信号：当前库的 datcompatibility
// 集中式 O模式 = 'A'，分布式 O模式 = 'ORA'（华为命名约定，507 轻量化集中式统一 A）
// 辅信号：pgxc_node 行数 0=集中式，>0=分布式（交叉确认）
const r = await pool.query(
  'SELECT datcompatibility FROM pg_database WHERE datname = current_database()'
);
const compat = r.rows[0].datcompatibility;
const isCentralized = compat === 'A';  // 'ORA' = 分布式
```
> N-EXP-08 实测：当前集中式实例 n8n_test datcompatibility=A，pgxc_node count=0（双信号一致）。客户确认：集中式 DBCOMPATIBILITY='A'，分布式 DBCOMPATIBILITY='ORA'。此判定查当前库即可，比 pgxc_node 更直接，双信号交叉更稳健。

**步骤 2 · 探测维度上限**（建临时 floatvector 列试维度，确定当前库实际支持）：
```ts
// 不硬编码 1024/4096，而是实测当前库支持的最大维度
// 试客户要用的维度，能建则支持
async function probeDimSupport(pool, dim) {
  try {
    await pool.query(`CREATE TABLE n8n_dimprobe (id int, v floatvector(${dim}) NOT NULL)`);
    await pool.query('DROP TABLE n8n_dimprobe');
    return true;
  } catch { return false; }
}
```
> N-EXP-08 实测：当前集中式库支持 4096 维 floatvector 列。此法让节点适应不同实例的实际能力，而非硬编码假设。

**步骤 3 · 自动选索引**（按形态 + 实测维度上限自动决定）：

| 客户维度 dim | 探测结果 | 自动选索引 | 说明 |
|---|---|---|---|
| dim ≤ 1024 | 任一 | GsIVFFLAT（`ivf_nlist=256`） | 简单，全形态可用 |
| 1024 < dim ≤ 实测上限 | 集中式（或实测支持） | GsDiskANN+PQ | 自动加 PQ，pq_nseg 按算法 |
| dim > 实测上限 | 数据库物理不支持 | **友好提示**（唯一无法绕过） | 见下方"友好提示" |

**友好提示**（仅 dim 超过数据库物理上限时，替代裸数据库报错）：
```ts
throw new NodeOperationError(this.getNode(), 
  `当前 GaussDB 库不支持 ${dim} 维向量。` +
  `该库${isCentralized ? '为集中式形态' : '为分布式形态（向量维度上限 1024）'}，` +
  `实测支持的最大维度为 ${maxSupportedDim}。` +
  `请选 ≤ ${maxSupportedDim} 维的 embedding 模型，或联系 DBA 确认是否可切换集中式形态以支持更高维度。`,
  { level: 'error' }
);
```
> 此提示告知客户：实际形态、实测上限、怎么改（换模型或换形态），可定位。不抛裸 `Vector field cannot have more than 1024 dimensions` 这种数据库报错。

**indexType 参数仍保留**（auto/gsivfflat/gsdiskann，default auto）：
- auto（默认）：按上述三步自动探测 + 自动选
- gsivfflat/gsdiskann：客户显式选时，仍按维度自动决定是否加 PQ（>1024 维 gsdiskann 自动加 PQ），不因客户选 gsivfflat 而 >1024 报错——而是自动回退 gsdiskann+PQ 并日志提示"已自动切换为 GsDiskANN+PQ（GsIVFFLAT 上限 1024）"

**pq_nseg 算法**（>1024 维 GsDiskANN+PQ，N-EXP-06 实测确认）：
- `<512→=dim`；`512~1024→=dim/2`；`>1024→取整除值`（96/128/192/256/384）
- 实测值：1536→96，3072→96，4096→128

### VectorStoreGaussDB.node.ts（标准版，照 PGVector 节点）

```ts
export class VectorStoreGaussDB extends createVectorStoreNode({
  meta: {
    displayName: 'GaussDB Vector Store',
    name: 'vectorStoreGaussDB',
    credentials: [{ name: 'postgres', required: true, testedBy: 'postgresConnectionTest' }],
    operationModes: ['load', 'insert', 'retrieve', 'retrieve-as-tool'],
  },
  sharedFields: [tableNameField, indexTypeField],  // indexType 是新增参数
  loadFields: [retrieveFields],
  retrieveFields,
  async getVectorStoreClient(context, filter, embeddings, itemIndex) {
    const credentials = await context.getCredentials('postgres');
    const pgConf = await configurePostgres.call(context, credentials);
    const pool = pgConf.db.$pool as unknown as pg.Pool;
    const tableName = context.getNodeParameter('tableName', itemIndex, 'n8n_vectors');
    const indexType = context.getNodeParameter('indexType', itemIndex, 'auto');
    return GaussDBVectorStore.initialize(embeddings, { pool, tableName, indexType, filter });
  },
  async populateVectorStore(context, embeddings, documents, itemIndex) {
    // 调 getVectorStoreClient + addDocuments
  },
  releaseVectorStoreClient(vectorStore) { vectorStore.client?.release(); },
}) {}
```

**新增 indexType 参数**（sharedFields）：options auto/gsivfflat/gsdiskann，default auto。

### ChatHubVectorStoreGaussDB.node.ts（照 ChatHubVectorStorePGVector）

```ts
export class ChatHubVectorStoreGaussDB extends createVectorStoreNode({
  hidden: true,
  methods: {
    credentialTest: { chatHubVectorStoreGaussDBApiConnectionTest },
    actionHandler: { deleteDocuments },
  },
  meta: {
    displayName: 'ChatHub GaussDB Store',
    name: 'chatHubVectorStoreGaussDB',
    credentials: [{ name: 'chatHubVectorStoreGaussDBApi', required: true, testededBy: '...' }],
    operationModes: ['load', 'insert', 'retrieve', 'retrieve-as-tool'],
  },
  async getVectorStoreClient(context, filter, embeddings, itemIndex) {
    const credentials = await context.getCredentials('chatHubVectorStoreGaussDBApi');
    const tableName = getUserScopedSlot(context, credentials.tableNamePrefix, itemIndex);  // 用户级表隔离
    const pgConf = await configurePostgres.call(context, credentials);
    const pool = pgConf.db.$pool as unknown as pg.Pool;
    const store = await GaussDBVectorStore.initialize(embeddings, { pool, tableName, filter });
    // 包装 similaritySearchVectorWithScore，加 filterChatHubMetadata
    const originalSearch = store.similaritySearchVectorWithScore.bind(store);
    store.similaritySearchVectorWithScore = async (...args) => {
      const results = await originalSearch(...args);
      return results.map(([doc, score]) => [
        { ...doc, metadata: filterChatHubMetadata(doc.metadata, CHAT_HUB_RETRIEVE_METADATA_KEYS) },
        score,
      ]);
    };
    return store;
  },
  // populateVectorStore 同理，加 filterChatHubInsertDocuments
}) {}
```

**与 PGVector ChatHub 版的差异**：
- 复用 `GaussDBVectorStore`（而非 ExtendedPGVectorStore）
- 凭据测试：不检查 pgvector 扩展，改为检查 `enable_vectordb=on`（`SHOW enable_vectordb`）或 `floatvector` 类型可用
- 凭据 `chatHubVectorStoreGaussDBApi` = postgres 凭据 + tableNamePrefix

### ChatHub 版凭据测试改造

PGVector ChatHub 版（:99-109）检查 `pg_extension WHERE extname='vector'`。GaussDB 版改为：
```ts
// 检查 enable_vectordb=on
const r = await pool.query('SHOW enable_vectordb');
if (r.rows[0].enable_vectordb !== 'on') {
  return { status: 'Error', message: 'enable_vectordb is off. Please enable it at instance level and restart GaussDB.' };
}
```

## 关键实现细节

### score 统一
GaussDBVectorStore.similaritySearchVectorWithScore 返回 `[doc, 1 - distance]`（GaussDB `<+>` 是余弦距离 [0,2]）。不沿用 LangChain PGVectorStore 的 `(2-d)/2`。N-EXP-03 实测确认 `1-distance` 成立（id=1 dist=0 score=1.0）。

### maintenance_work_mem
建向量索引前会话级 `SET maintenance_work_mem='512MB'`（**GaussDB 要求带引号**，N-EXP-05 实测）。实例默认 16MB 太小。

### O模式适配（N-EXP-07）
- **B id 列**：`varchar(36)` + 应用层 `uuid()`（from `n8n-workflow`），不用 `gen_random_uuid()`（O模式不存在）
- **C 判空**：`IS NULL` 不用 `=''`（O模式空串→NULL）
- **jsonb**：`->`/`->>`/`?|` 全可用，buildFilterClauses 无需改写
- **RETURNING**：可用

### pq_nseg 整除算法
`<512→=dim`；`512~1024→=dim/2`；`>1024→取整除值`。N-EXP-06 实测：1536→96，3072→96，4096→128。

## 测试策略

### C 节点测试
- NodeTestHarness + mock pg-promise，测 6 operation happy path + 错误处理
- 连真实 GaussDB 的集成测试：已有 pyexp 探针（N-EXP-02）验证连通
- 测 O模式空串→NULL 场景（INSERT 空串、WHERE 判空）

### B GaussDBVectorStore 测试
- 单元测试 mock pg.Pool，测 addVectors/similaritySearchVectorWithScore/ensureTable/createIndex 的 SQL 生成
- 测 score 计算（1-distance）
- 测 indexType 选择逻辑（auto/gsivfflat/gsdiskann + 维度分支）
- 测 pq_nseg 算法（多维度）

### B 节点测试
- NodeTestHarness 测 4 种 mode（load/insert/retrieve/retrieve-as-tool）
- ChatHub 版测用户级表隔离 + metadata 过滤

### 类型规范（packages/nodes-base/AGENTS.md）
- 不用 `any`
- 避免 `as`（除 `db.$pool as unknown as pg.Pool` 沿用 PGVector 先例，pg-promise 底层即 pg.Pool）
- `NodeOperationError` 用于用户错误（分布式>1024维、GsIVFFLAT>1024维）

## 不在本 spec 范围

- A 维度（n8n 主库跑 GaussDB）—— P2，非客户场景
- C 的 SSH 隧道 / 连接池复用 / 大数解析 —— 初版精简，后续按需加
- >4096 维 embedding —— GaussDB 硬上限
- 向量库性能调优（IVF_NLIST/GsDiskANN 参数细调）—— 留运维侧
- GaussDB M-Compatibility 模式适配 —— 本次只做 O模式

## 风险与降级

| 风险 | 降级方案 |
|---|---|
| GaussDB 对 pgp.helpers 多行 INSERT/UPDATE 不兼容（CrateDb 遇过） | 实测验证，必要时改单行循环（照 CrateDb :336-384） |
| upsert 的 ON CONFLICT 语法 GaussDB O模式是否支持 | 实测，不支持则用 MERGE INTO（O模式原生支持） |
| gen_random_uuid 不可用 | 已定方案：varchar(36) + 应用层 uuid() |
| score 语义与 n8n 下游假设不符 | 实测 AI Agent / load mode 对 score 范围的假设，必要时归一化 |
| ChatHub 版凭据测试检查 enable_vectordb 的权限 | appuser 可能无 SHOW 权限，降级为建 floatvector 测试表验证 |
