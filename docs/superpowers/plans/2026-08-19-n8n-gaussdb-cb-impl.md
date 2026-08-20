# n8n 适配 GaussDB C+B 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 n8n 适配 GaussDB 的 C 维度（GaussDb 数据库节点，6 operation）+ B 维度（VectorStoreGaussDB 标准版 + ChatHubVectorStoreGaussDB ChatHub 版），让客户在 workflow 里能用 GaussDB 做智数查询和 RAG 向量存储。

**Architecture:** C 参考 Postgres v2 多文件结构，新建 `configureGaussDb`（nodeType:'gaussDb'），复用 `Postgres/v1/genericFunctions`。B 自建 `GaussDBVectorStore extends VectorStore`（两节点共用），复用 createVectorStoreNode 工厂 + postgres 凭据。O模式适配：id 用 varchar(36)+应用层 uuid()，判空用 IS NULL。索引自动探测形态（datcompatibility A=集中式/ORA=分布式）+ 维度上限，不抛报错（仅物理硬限给友好提示）。

**Tech Stack:** TypeScript、pg-promise 11.9.1、node pg 8.x、@langchain/community（VectorStore 基类）、n8n-workflow（INodeType/uuid/NodeOperationError）、GaussDB Kernel 507（集中式/O模式/enable_vectordb=on）。

**环境说明：** n8n-stable 不是 git 仓库（GitHub release 解压源码，无 .git）。plan 里"commit"步骤改为"标记任务完成"，不实际 git commit。测试用 `pnpm test`（Vitest）。实测探针已在 `survey/pyexp/` 验证连通（N-EXP-01~08）。

**前置条件（已满足）：** pg-promise/node pg 直连 GaussDB ✅（N-EXP-01/02）；floatvector 向量全链路 ✅（N-EXP-03）；pgvector 不兼容需自建 ✅（N-EXP-04）；维度上限+PQ4096 ✅（N-EXP-05/06）；O模式适配 ✅（N-EXP-07）；形态探测 ✅（N-EXP-08）。

**关键参考文件：**
- C 模板：`packages/nodes-base/nodes/Postgres/v2/`（多文件结构）+ `nodes/CrateDb/CrateDb.node.ts`（PG协议兼容范例）+ `nodes/Postgres/v1/genericFunctions.ts`（复用函数）
- B 模板：`packages/@n8n/nodes-langchain/nodes/vector_store/VectorStorePGVector/`（标准版）+ `ChatHubVectorStorePGVector/`（ChatHub版）+ `shared/`（ChatHub共享）
- 工厂：`packages/@n8n/ai-utilities/src/utils/vector-store/createVectorStoreNode/`

---

## 文件结构

### C 维度（packages/nodes-base，新增）
```
nodes/GaussDb/
├── GaussDb.node.ts                    # implements INodeType，execute→router
├── gaussdb.svg
├── transport/index.ts                 # configureGaussDb（pgPromise，nodeType:'gaussDb'）
├── actions/router.ts / versionDescription.ts / common.descriptions.ts
├── actions/database/{Database.resource,executeQuery,insert,update,upsert,select,deleteTable}.operation.ts
├── helpers/interfaces.ts              # GaussDbNodeCredentials
└── methods/{credentialTest,listSearch,loadOptions}.ts
credentials/GaussDb.credentials.ts     # name='gaussDb'
```

### B 维度（packages/@n8n/nodes-langchain，新增）
```
nodes/vector_store/VectorStoreGaussDB/
├── VectorStoreGaussDB.node.ts         # 标准节点（createVectorStoreNode 工厂）
├── GaussDBVectorStore.ts              # 核心：extends VectorStore（两节点共用）
└── gaussdb.svg
nodes/vector_store/ChatHubVectorStoreGaussDB/
└── ChatHubVectorStoreGaussDB.node.ts  # ChatHub版（复用 GaussDBVectorStore）
credentials/ChatHubVectorStoreGaussDBApi.credentials.ts  # extends postgres + tableNamePrefix
```

**职责边界：**
- `GaussDBVectorStore.ts`：唯一封装 GaussDB 向量 SQL 的地方（floatvector/`<+>`/GsIVFFLAT/GsDiskANN+PQ/score=1-dist/形态探测/维度探测）。两节点共用，改一处生效。
- C 的 `configureGaussDb`：唯一管 GaussDb 节点连接的地方（pgPromise 初始化，nodeType:'gaussDb' 池 key）。
- operations：纯复用 `Postgres/v1/genericFunctions`，不重写 SQL。

---

## Task 1: C 维度 — GaussDb 凭据

**Files:**
- Create: `packages/nodes-base/credentials/GaussDb.credentials.ts`
- Test: `packages/nodes-base/credentials/GaussDb.credentials.test.ts`

- [ ] **Step 1: 写凭据测试**

```ts
import { GaussDb } from './GaussDb.credentials';

describe('GaussDb credentials', () => {
	const cred = new GaussDb();
	it('should have name gaussDb', () => {
		expect(cred.name).toBe('gaussDb');
	});
	it('should have displayName GaussDB', () => {
		expect(cred.displayName).toBe('GaussDB');
	});
	it('should have required fields', () => {
		const names = cred.properties.map((p) => p.name);
		expect(names).toEqual(expect.arrayContaining(['host', 'database', 'user', 'password', 'port', 'ssl']));
	});
	it('should default port to 8000', () => {
		const port = cred.properties.find((p) => p.name === 'port');
		expect(port?.default).toBe(8000);
	});
	it('should default ssl to disable', () => {
		const ssl = cred.properties.find((p) => p.name === 'ssl');
		expect(ssl?.default).toBe('disable');
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/nodes-base && pnpm test GaussDb.credentials.test`
Expected: FAIL（GaussDb.credentials.ts 不存在）

- [ ] **Step 3: 写凭据实现（照 CrateDb.credentials.ts，port default 8000）**

```ts
import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class GaussDb implements ICredentialType {
	name = 'gaussDb';
	displayName = 'GaussDB';
	documentationUrl = 'gaussdb';
	properties: INodeProperties[] = [
		{ displayName: 'Host', name: 'host', type: 'string', default: 'localhost' },
		{ displayName: 'Database', name: 'database', type: 'string', default: 'postgres' },
		{ displayName: 'User', name: 'user', type: 'string', default: 'gaussdb' },
		{ displayName: 'Password', name: 'password', type: 'string', typeOptions: { password: true }, default: '' },
		{
			displayName: 'SSL', name: 'ssl', type: 'options',
			options: [
				{ name: 'Allow', value: 'allow' },
				{ name: 'Disable', value: 'disable' },
				{ name: 'Require', value: 'require' },
			],
			default: 'disable',
		},
		{ displayName: 'Port', name: 'port', type: 'number', default: 8000 },
	];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/nodes-base && pnpm test GaussDb.credentials.test`
Expected: PASS（5/5）

- [ ] **Step 5: 注册凭据到 package.json**

Modify: `packages/nodes-base/package.json`，在 n8n.credentials 数组（CrateDb 在 :95）后加：
```json
"dist/credentials/GaussDb.credentials.js",
```

- [ ] **Step 6: 标记完成**

---

## Task 2: C 维度 — transport（configureGaussDb）+ helpers

**Files:**
- Create: `packages/nodes-base/nodes/GaussDb/helpers/interfaces.ts`
- Create: `packages/nodes-base/nodes/GaussDb/transport/index.ts`
- Test: `packages/nodes-base/nodes/GaussDb/transport/index.test.ts`

- [ ] **Step 1: 写 helpers/interfaces.ts**

```ts
export interface GaussDbNodeCredentials {
	host: string;
	database: string;
	user: string;
	password: string;
	port: number;
	ssl: 'allow' | 'disable' | 'require';
}

export interface GaussDbConnectionData {
	db: import('pg-promise').IDatabase<unknown>;
	pgp: import('pg-promise').IMain;
}
```

- [ ] **Step 2: 写 transport 测试（mock pg-promise）**

```ts
import { vi } from 'vitest';

vi.mock('pg-promise', () => {
	const db = { $pool: { end: vi.fn() }, any: vi.fn(), none: vi.fn(), one: vi.fn() };
	const pgp: any = (opts: any) => db;
	(pgp as any).end = vi.fn();
	return { default: pgp };
});

import { configureGaussDb } from './index';

describe('configureGaussDb', () => {
	it('should init pgp with correct config', async () => {
		const credentials = { host: 'h', database: 'd', user: 'u', password: 'p', port: 8000, ssl: 'disable' as const };
		const ctx: any = { getCredentials: vi.fn().mockResolvedValue(credentials), getNodeParameter: vi.fn() };
		const result = await configureGaussDb.call(ctx, credentials, { nodeVersion: 1, operation: 'executeQuery', largeNumbersOutput: 'numbers' });
		expect(result.db).toBeDefined();
		expect(result.pgp).toBeDefined();
	});
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/nodes-base && pnpm test GaussDb/transport/index.test`
Expected: FAIL（transport/index.ts 不存在）

- [ ] **Step 4: 写 transport/index.ts（照 CrateDb :266-282，内联 pgPromise，nodeType:'gaussDb'）**

```ts
import pgPromise from 'pg-promise';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { GaussDbNodeCredentials, GaussDbConnectionData } from '../helpers/interfaces';

const pgp = pgPromise({ noWarnings: true });

export async function configureGaussDb(
	this: IExecuteFunctions,
	credentials: GaussDbNodeCredentials,
	_options: { nodeVersion: number; operation: string; largeNumbersOutput?: string },
): Promise<GaussDbConnectionData> {
	const config = {
		host: credentials.host,
		port: credentials.port,
		database: credentials.database,
		user: credentials.user,
		password: credentials.password,
		ssl: !['disable', undefined].includes(credentials.ssl),
		sslmode: credentials.ssl || 'disable',
		max: 10,
	};
	const db = pgp(config);
	return { db, pgp };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/nodes-base && pnpm test GaussDb/transport/index.test`
Expected: PASS

- [ ] **Step 6: 标记完成**

---

## Task 3: C 维度 — actions 骨架（router + versionDescription + Database.resource）

**Files:**
- Create: `packages/nodes-base/nodes/GaussDb/actions/router.ts`
- Create: `packages/nodes-base/nodes/GaussDb/actions/versionDescription.ts`
- Create: `packages/nodes-base/nodes/GaussDb/actions/common.descriptions.ts`
- Create: `packages/nodes-base/nodes/GaussDb/actions/database/Database.resource.ts`

- [ ] **Step 1: 写 common.descriptions.ts（照 Postgres v2 common.descriptions.ts，复用 schemaRLC/tableRLC）**

参考 `packages/nodes-base/nodes/Postgres/v2/actions/common.descriptions.ts`，导出 `schemaRLC` 和 `tableRLC`（resourceLocator 配置）。可直接 import 复用或复制。推荐 import 复用：

```ts
export { schemaRLC, tableRLC } from '../../Postgres/v2/actions/common.descriptions';
```

- [ ] **Step 2: 写 Database.resource.ts（照 Postgres Database.resource.ts:1-58，6 operation）**

```ts
import type { INodeProperties } from 'n8n-workflow';
import * as deleteTable from './deleteTable.operation';
import * as executeQuery from './executeQuery.operation';
import * as insert from './insert.operation';
import * as select from './select.operation';
import * as update from './update.operation';
import * as upsert from './upsert.operation';
import { schemaRLC, tableRLC } from '../common.descriptions';

export { deleteTable, executeQuery, insert, select, update, upsert };

export const description: INodeProperties[] = [
	{
		displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true,
		options: [
			{ name: 'Delete', value: 'deleteTable', description: 'Delete an entire table or rows in a table', action: 'Delete table or rows' },
			{ name: 'Execute Query', value: 'executeQuery', description: 'Execute an SQL query', action: 'Execute a SQL query' },
			{ name: 'Insert', value: 'insert', description: 'Insert rows in a table', action: 'Insert rows in a table' },
			{ name: 'Insert or Update', value: 'upsert', description: 'Insert or update rows in a table', action: 'Insert or update rows in a table' },
			{ name: 'Select', value: 'select', description: 'Select rows from a table', action: 'Select rows from a table' },
			{ name: 'Update', value: 'update', description: 'Update rows in a table', action: 'Update rows in a table' },
		],
		default: 'executeQuery',
	},
];
```

- [ ] **Step 3: 写 versionDescription.ts（照 Postgres v2 versionDescription.ts，credentials name='gaussDb'）**

参考 `packages/nodes-base/nodes/Postgres/v2/actions/versionDescription.ts`，改：
- `credentials: [{ name: 'gaussDb', required: true, testedBy: 'gaussDbConnectionTest' }]`
- `displayName: 'GaussDB'`, `name: 'gaussDb'`, `icon: 'file:gaussdb.svg'`
- `sqlDialect: 'PostgreSQL'`（在 executeQuery 的 query 字段 typeOptions）

- [ ] **Step 4: 写 router.ts（照 Postgres v2 router.ts:15-64，改 configurePostgres→configureGaussDb）**

参考 `packages/nodes-base/nodes/Postgres/v2/actions/router.ts`，把 `configurePostgres` 换成 `configureGaussDb`，凭据类型换 `GaussDbNodeCredentials`，其余结构（getInputData → getNodeParameter → getCredentials → configureGaussDb → configureQueryRunner → switch(resource)）不变。`configureQueryRunner` 可复用 `Postgres/v2/helpers/utils.ts:359-374`。

- [ ] **Step 5: 标记完成**

> 注：本 task 是骨架，6 个 operation 文件在 Task 4-9 逐个实现。router/versionDescription 暂时 import 不存在的 operation 文件，typecheck 会报错——在 Task 4-9 完成后消除。

---

## Task 4: C 维度 — executeQuery operation

**Files:**
- Create: `packages/nodes-base/nodes/GaussDb/actions/database/executeQuery.operation.ts`
- Test: `packages/nodes-base/nodes/GaussDb/actions/database/executeQuery.operation.test.ts`

- [ ] **Step 1: 写测试（照 Postgres executeQuery.operation.test.ts，mock runQueries）**

参考 `packages/nodes-base/nodes/Postgres/v2/actions/database/executeQuery.operation.test.ts`，改节点名 gaussDb。测 happy path（执行 SELECT 返回行）+ 错误处理（SQL 语法错）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/nodes-base && pnpm test executeQuery.operation.test`
Expected: FAIL

- [ ] **Step 3: 写实现（照 Postgres executeQuery.operation.ts，复用 pgQueryV2，sqlDialect:'PostgreSQL'）**

参考 `packages/nodes-base/nodes/Postgres/v2/actions/database/executeQuery.operation.ts`，改：
- import `pgQueryV2` from `../../../Postgres/v1/genericFunctions`
- query 字段 `typeOptions: { editor: 'sqlEditor', rows: 5, sqlDialect: 'PostgreSQL' }`
- execute 调 `pgQueryV2.call(this, runQueries, items, options, db, pgp)`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/nodes-base && pnpm test executeQuery.operation.test`
Expected: PASS

- [ ] **Step 5: 标记完成**

---

## Task 5: C 维度 — insert operation

**Files:**
- Create: `packages/nodes-base/nodes/GaussDb/actions/database/insert.operation.ts`
- Test: `packages/nodes-base/nodes/GaussDb/actions/database/insert.operation.test.ts`

- [ ] **Step 1: 写测试（照 Postgres insert.operation.test.ts）**

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 写实现（复用 pgInsert，注意 O模式空串→NULL）**

参考 `packages/nodes-base/nodes/Postgres/v2/actions/database/insert.operation.ts`，import `pgInsert` from `../../../Postgres/v1/genericFunctions`。execute 调 `pgInsert.call(this, runQueries, items, options, db, pgp)`。O模式注意：pgInsert 生成的 SQL 空串会→NULL，符合 O模式行为，无需特殊处理（CrateDb 先例）。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 标记完成**

---

## Task 6: C 维度 — update operation

**Files:**
- Create: `packages/nodes-base/nodes/GaussDb/actions/database/update.operation.ts`
- Test: `.../update.operation.test.ts`

- [ ] **Step 1: 写测试**

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 写实现（复用 pgUpdate）**

参考 Postgres update.operation.ts，import `pgUpdate` from `../../../Postgres/v1/genericFunctions`，execute 调 `pgUpdate.call(this, ...)`。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 标记完成**

---

## Task 7: C 维度 — select operation

**Files:**
- Create: `.../select.operation.ts`
- Test: `.../select.operation.test.ts`

- [ ] **Step 1: 写测试**

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 写实现（复用 pgQueryV2 构造 SELECT）**

参考 Postgres select.operation.ts，用 pgQueryV2 执行 SELECT，返回行。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 标记完成**

---

## Task 8: C 维度 — deleteTable operation

**Files:**
- Create: `.../deleteTable.operation.ts`
- Test: `.../deleteTable.operation.test.ts`

- [ ] **Step 1: 写测试**

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 写实现（复用 pgQueryV2 构造 DELETE/DROP）**

参考 Postgres deleteTable.operation.ts，支持删整表（DROP）或按条件删行（DELETE）。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 标记完成**

---

## Task 9: C 维度 — upsert operation

**Files:**
- Create: `.../upsert.operation.ts`
- Test: `.../upsert.operation.test.ts`

- [ ] **Step 1: 写测试**

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 写实现（复用 pgUpdate ON CONFLICT 模式；O模式降级 MERGE INTO）**

参考 Postgres upsert.operation.ts，import `pgUpdate`。先试 `ON CONFLICT` 语法（O模式是否支持待实测）；不支持则降级 `MERGE INTO`（O模式原生支持）。实现时先按 ON CONFLICT 写，若集成测试在真实 GaussDB 失败，改 MERGE INTO 分支。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 标记完成**

---

## Task 10: C 维度 — methods（credentialTest + listSearch + loadOptions）

**Files:**
- Create: `packages/nodes-base/nodes/GaussDb/methods/credentialTest.ts`
- Create: `packages/nodes-base/nodes/GaussDb/methods/listSearch.ts`
- Create: `packages/nodes-base/nodes/GaussDb/methods/loadOptions.ts`

- [ ] **Step 1: 写 credentialTest.ts（照 Postgres methods/credentialTest.ts:10-50，捕 ECONNREFUSED/认证错）**

参考 `packages/nodes-base/nodes/Postgres/v2/methods/credentialTest.ts`，改用 `configureGaussDb`，`db.connect()` 测试连通，捕 ECONNREFUSED/ENOTFOUND/ETIMEDOUT。

- [ ] **Step 2: 写 listSearch.ts（照 Postgres listSearch.ts，列 schema/table/column）**

参考 `packages/nodes-base/nodes/Postgres/v2/methods/listSearch.ts`，查 information_schema.tables/columns（GaussDB 兼容 PG，information_schema 可用）。

- [ ] **Step 3: 写 loadOptions.ts（照 Postgres loadOptions.ts）**

- [ ] **Step 4: 标记完成**

---

## Task 11: C 维度 — GaussDb.node.ts 主文件 + 图标 + 注册

**Files:**
- Create: `packages/nodes-base/nodes/GaussDb/GaussDb.node.ts`
- Create: `packages/nodes-base/nodes/GaussDb/gaussdb.svg`
- Modify: `packages/nodes-base/package.json`

- [ ] **Step 1: 写 GaussDb.node.ts（照 PostgresV2.node.ts:13-28）**

```ts
import type { INodeType, INodeTypeBaseDescription, INodeTypeDescription, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { router } from './actions/router';
import { versionDescription } from './actions/versionDescription';
import { listSearch } from './methods/listSearch';
import { loadOptions } from './methods/loadOptions';
import { gaussDbConnectionTest } from './methods/credentialTest';

export class GaussDb implements INodeType {
	description: INodeTypeDescription;
	methods = { listSearch, loadOptions, credentialTest: { gaussDbConnectionTest } };
	constructor(baseDescription: INodeTypeBaseDescription) {
		this.description = { ...baseDescription, ...versionDescription };
	}
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await router.call(this);
	}
}
```

- [ ] **Step 2: 放 gaussdb.svg（用 Postgres.svg 改色或新建简单图标）**

参考 `packages/nodes-base/nodes/Postgres/postgres.svg`，复制改色（GaussDB 品牌色红/橙）或用占位 SVG。

- [ ] **Step 3: 注册节点到 package.json**

Modify: `packages/nodes-base/package.json`，n8n.nodes 数组（CrateDb 在 :513）后加：
```json
"dist/nodes/GaussDb/GaussDb.node.js",
```

- [ ] **Step 4: typecheck**

Run: `cd packages/nodes-base && pnpm typecheck`
Expected: 无错误（所有 operation/method 文件已就位）

- [ ] **Step 5: 集成测试（连真实 GaussDB，用 survey/pyexp 验证过的 n8n_test 库）**

启动 n8n dev：`cd D:/workplace/code/n8n-stable && pnpm dev:be`，在 UI 加 GaussDb 凭据（localhost:5432/n8n_test/appuser），建测试 workflow 执行 executeQuery（SELECT 1）、insert、select，确认跑通。

- [ ] **Step 6: 标记完成**

---

## Task 12: B 维度 — GaussDBVectorStore 核心（extends VectorStore）

**Files:**
- Create: `packages/@n8n/nodes-langchain/nodes/vector_store/VectorStoreGaussDB/GaussDBVectorStore.ts`
- Test: `.../GaussDBVectorStore.test.ts`

- [ ] **Step 1: 写测试（mock pg.Pool，测 SQL 生成 + score + 索引选择 + 形态探测）**

```ts
import { vi } from 'vitest';
import { GaussDBVectorStore } from './GaussDBVectorStore';

// mock pg.Pool
const mockQuery = vi.fn();
const mockPool: any = { query: mockQuery, connect: vi.fn().mockResolvedValue({ release: vi.fn() }) };

describe('GaussDBVectorStore', () => {
	it('ensureTable uses varchar(36) id (O模式无 gen_random_uuid)', async () => {
		mockQuery.mockResolvedValue({ rows: [] });
		const store = await GaussDBVectorStore.initialize(mockEmbeddings, { pool: mockPool, tableName: 't', dimensions: 3, indexType: 'auto' });
		await store.ensureTable();
		expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('id varchar(36) PRIMARY KEY'));
	});
	it('similaritySearchVectorWithScore uses <+> and score=1-distance', async () => {
		mockQuery.mockResolvedValue({ rows: [{ id: '1', content: 'hi', metadata: {}, distance: 0.2 }] });
		const store = await GaussDBVectorStore.initialize(mockEmbeddings, { pool: mockPool, tableName: 't', dimensions: 3, indexType: 'auto' });
		const results = await store.similaritySearchVectorWithScore([0.1, 0.2, 0.3], 5);
		expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('embedding <+>'));
		expect(results[0][1]).toBe(0.8); // 1 - 0.2
	});
	it('createIndex auto ≤1024 uses gsivfflat', async () => {
		mockQuery.mockResolvedValue({ rows: [] });
		const store = await GaussDBVectorStore.initialize(mockEmbeddings, { pool: mockPool, tableName: 't', dimensions: 768, indexType: 'auto' });
		await store.createIndex();
		expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('gsivfflat'));
	});
	it('createIndex auto >1024 uses gsdiskann+pq', async () => {
		mockQuery.mockResolvedValue({ rows: [{ count: 0 }] }); // pgxc_node count=0 集中式
		const store = await GaussDBVectorStore.initialize(mockEmbeddings, { pool: mockPool, tableName: 't', dimensions: 1536, indexType: 'auto' });
		await store.createIndex();
		expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('gsdiskann'));
		expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('enable_pq=true'));
	});
	it('detects centralized via datcompatibility=A', async () => {
		mockQuery.mockResolvedValueOnce({ rows: [{ datcompatibility: 'A' }] });
		const store = await GaussDBVectorStore.initialize(mockEmbeddings, { pool: mockPool, tableName: 't', dimensions: 1536, indexType: 'auto' });
		const isCentralized = await store.detectTopology();
		expect(isCentralized).toBe(true);
	});
});

const mockEmbeddings: any = { embedDocuments: vi.fn().mockResolvedValue([[0.1,0.2,0.3]]), embedQuery: vi.fn().mockResolvedValue([0.1,0.2,0.3]) };
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/@n8n/nodes-langchain && pnpm test GaussDBVectorStore.test`
Expected: FAIL

- [ ] **Step 3: 写 GaussDBVectorStore.ts（extends VectorStore，实现 5 方法 + 形态/维度探测）**

核心实现（完整代码，照 spec 第 4.3 节 + O模式适配 + 自动探测）：

```ts
import { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';
import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid'; // 或 n8n-workflow 的 uuid

export interface GaussDBVectorStoreArgs {
	pool: Pool;
	tableName: string;
	dimensions?: number;
	indexType?: 'auto' | 'gsivfflat' | 'gsdiskann';
	filter?: Record<string, unknown>;
}

export class GaussDBVectorStore extends VectorStore {
	pool: Pool;
	tableName: string;
	dimensions: number;
	indexType: 'auto' | 'gsivfflat' | 'gsdiskann';
	filter?: Record<string, unknown>;

	constructor(embeddings: any, args: GaussDBVectorStoreArgs) {
		super(embeddings, args);
		this.pool = args.pool;
		this.tableName = args.tableName;
		this.dimensions = args.dimensions ?? 0;
		this.indexType = args.indexType ?? 'auto';
		this.filter = args.filter;
	}

	static async initialize(embeddings: any, args: GaussDBVectorStoreArgs): Promise<GaussDBVectorStore> {
		const store = new GaussDBVectorStore(embeddings, args);
		if (store.dimensions) {
			await store.ensureTable();
			await store.createIndex();
		}
		return store;
	}

	// 形态探测：datcompatibility A=集中式 / ORA=分布式（辅 pgxc_node count）
	async detectTopology(): Promise<boolean> {
		const r = await this.pool.query("SELECT datcompatibility FROM pg_database WHERE datname = current_database()");
		return r.rows[0].datcompatibility === 'A';
	}

	// 维度上限探测：建临时 floatvector 列试维度
	async probeDimSupport(dim: number): Promise<boolean> {
		try {
			await this.pool.query(`CREATE TABLE n8n_dimprobe (id int, v floatvector(${dim}) NOT NULL)`);
			await this.pool.query('DROP TABLE n8n_dimprobe');
			return true;
		} catch { return false; }
	}

	async ensureTable(): Promise<void> {
		// O模式：id 用 varchar(36) + 应用层 uuid（gen_random_uuid 不存在）
		await this.pool.query(
			`CREATE TABLE IF NOT EXISTS "${this.tableName}" (
				id varchar(36) PRIMARY KEY,
				content text,
				embedding floatvector(${this.dimensions}) NOT NULL,
				metadata jsonb
			)`
		);
	}

	async createIndex(): Promise<void> {
		// 会话级调大 maintenance_work_mem（GaussDB 带引号）
		await this.pool.query("SET maintenance_work_mem = '512MB'");
		const dim = this.dimensions;
		let useIvfflat = dim <= 1024;
		let useDiskannPq = false;

		if (this.indexType === 'gsivfflat') {
			if (dim > 1024) { useIvfflat = false; useDiskannPq = true; } // 自动回退，不报错
		} else if (this.indexType === 'gsdiskann') {
			useIvfflat = false; useDiskannPq = dim > 1024;
		} else { // auto
			useIvfflat = dim <= 1024;
			useDiskannPq = dim > 1024;
			if (useDiskannPq) {
				const isCentralized = await this.detectTopology();
				if (!isCentralized) {
					// 分布式 >1024 维：探测实际上限，超限给友好提示
					const supported = await this.probeDimSupport(dim);
					if (!supported) {
						throw new Error(
							`当前 GaussDB 库为分布式形态（向量维度上限 1024），不支持 ${dim} 维。` +
							`请选 ≤ 1024 维的 embedding 模型，或联系 DBA 确认是否可切换集中式形态以支持更高维度。`
						);
					}
				}
			}
		}

		if (useIvfflat) {
			await this.pool.query(
				`CREATE INDEX IF NOT EXISTS "${this.tableName}_embedding_idx" ON "${this.tableName}" USING gsivfflat (embedding cosine) WITH (ivf_nlist = 256)`
			);
		} else {
			const pqNseg = this.calcPqNseg(dim);
			const enablePq = useDiskannPq;
			await this.pool.query(
				`CREATE INDEX IF NOT EXISTS "${this.tableName}_embedding_idx" ON "${this.tableName}" USING gsdiskann (embedding cosine) WITH (pq_nseg = ${pqNseg}, pq_nclus = 16, enable_pq = ${enablePq}, subgraph_count = 1, enable_vector_copy = false)`
			);
		}
	}

	calcPqNseg(dim: number): number {
		if (dim <= 512) return dim;
		if (dim <= 1024) return dim / 2;
		for (const c of [96, 128, 192, 256, 384]) if (dim % c === 0) return c;
		return Math.floor(dim / 4);
	}

	async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
		// O模式：应用层生成 uuid（gen_random_uuid 不存在），字符串字面量 [v1,v2,...]
		const values = vectors.map((v, i) => [
			uuidv4(),
			documents[i].pageContent,
			`[${v.join(',')}]`,
			JSON.stringify(documents[i].metadata ?? {}),
		]);
		// 用 pg-promise 或 pg 构造批量 INSERT
		const placeholders = values.map((_, i) => `($${i*4+1}, $${i*4+2}, $${i*4+3}::floatvector, $${i*4+4})`).join(', ');
		const flat = values.flat();
		await this.pool.query(
			`INSERT INTO "${this.tableName}" (id, content, embedding, metadata) VALUES ${placeholders}`,
			flat
		);
	}

	async similaritySearchVectorWithScore(query: number[], k: number, filter?: Record<string, unknown>): Promise<[Document, number][]> {
		// SET gsivfflat_probes（若用 gsivfflat，可选优化）
		const filterClauses = this.buildFilterClauses({ ...this.filter, ...filter });
		const where = filterClauses.clauses.length ? `WHERE ${filterClauses.clauses.join(' AND ')}` : '';
		const offset = filterClauses.clauses.length ? filterClauses.params.length : 0;
		const sql = `SELECT id, content, metadata, embedding <+> $1::floatvector AS distance FROM "${this.tableName}" ${where} ORDER BY distance LIMIT $${offset + 2}`;
		const r = await this.pool.query(sql, [`[${query.join(',')}]`, ...filterClauses.params, k]);
		return r.rows.map((row: any) => [new Document({ pageContent: row.content, metadata: row.metadata }), 1 - Number(row.distance)]);
	}

	buildFilterClauses(filter: Record<string, unknown>): { clauses: string[]; params: any[] } {
		// 复用 PGVectorStore buildFilterClauses 逻辑（->>/?| 操作符 O模式可用）
		const clauses: string[] = []; const params: any[] = [];
		for (const [key, value] of Object.entries(filter)) {
			if (Array.isArray(value)) {
				clauses.push(`metadata->>'${key}' IN (${value.map((_, i) => `$${params.length + i + 1}`).join(',')})`);
				params.push(...value);
			} else {
				clauses.push(`metadata->>'${key}' = $${params.length + 1}`);
				params.push(value);
			}
		}
		return { clauses, params };
	}

	async delete(params: { ids?: string[] } | { filter?: Record<string, unknown> }): Promise<void> {
		if ('ids' in params && params.ids) {
			await this.pool.query(`DELETE FROM "${this.tableName}" WHERE id = ANY($1)`, [params.ids]);
		} else if ('filter' in params && params.filter) {
			const fc = this.buildFilterClauses(params.filter);
			await this.pool.query(`DELETE FROM "${this.tableName}" WHERE ${fc.clauses.join(' AND ')}`, fc.params);
		}
	}

	addDocuments(documents: Document[], options?: { ids?: string[] }): Promise<void> {
		// VectorStore 基类 addDocuments 会调 embedDocuments + addVectors
		return super.addDocuments(documents, options);
	}

	_similaritySearchVectorWithScore(query: number[], k: number, filter?: Record<string, unknown>): Promise<[Document, number][]> {
		return this.similaritySearchVectorWithScore(query, k, filter);
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/@n8n/nodes-langchain && pnpm test GaussDBVectorStore.test`
Expected: PASS

- [ ] **Step 5: 标记完成**

---

## Task 13: B 维度 — VectorStoreGaussDB 标准节点

**Files:**
- Create: `packages/@n8n/nodes-langchain/nodes/vector_store/VectorStoreGaussDB/VectorStoreGaussDB.node.ts`
- Create: `.../gaussdb.svg`
- Test: `.../VectorStoreGaussDB.node.test.ts`

- [ ] **Step 1: 写节点（照 PGVector 节点，复用 createVectorStoreNode 工厂 + postgres 凭据 + 新增 indexType 参数）**

参考 `packages/@n8n/nodes-langchain/nodes/vector_store/VectorStorePGVector/VectorStorePGVector.node.ts`，改：
- import `GaussDBVectorStore` from `./GaussDBVectorStore`
- `meta.name = 'vectorStoreGaussDB'`, `displayName = 'GaussDB Vector Store'`, `icon = 'file:gaussdb.svg'`
- `credentials: [{ name: 'postgres', required: true, testedBy: 'postgresConnectionTest' }]`（复用 postgres 凭据）
- sharedFields 加 indexTypeField（options auto/gsivfflat/gsdiskann，default auto）
- `getVectorStoreClient`：getCredentials('postgres') → configurePostgres → db.$pool → GaussDBVectorStore.initialize(embeddings, { pool, tableName, indexType, filter })
- `populateVectorStore`：调 getVectorStoreClient + addDocuments

- [ ] **Step 2: 写测试（NodeTestHarness，mock configurePostgres + GaussDBVectorStore）**

参考 `VectorStorePGVector.node.test.ts`，测 4 种 mode（load/insert/retrieve/retrieve-as-tool）。mock GaussDBVectorStore 的 SQL。

- [ ] **Step 3: 跑测试确认通过**

Run: `cd packages/@n8n/nodes-langchain && pnpm test VectorStoreGaussDB.node.test`
Expected: PASS

- [ ] **Step 4: 注册节点到 package.json**

Modify: `packages/@n8n/nodes-langchain/package.json`，n8n.nodes 数组（VectorStorePGVector 在 :190）后加：
```json
"dist/nodes/vector_store/VectorStoreGaussDB/VectorStoreGaussDB.node.js",
```

- [ ] **Step 5: 标记完成**

---

## Task 14: B 维度 — ChatHubVectorStoreGaussDB 凭据 + 节点

**Files:**
- Create: `packages/@n8n/nodes-langchain/credentials/ChatHubVectorStoreGaussDBApi.credentials.ts`
- Create: `packages/@n8n/nodes-langchain/nodes/vector_store/ChatHubVectorStoreGaussDB/ChatHubVectorStoreGaussDB.node.ts`
- Test: `.../ChatHubVectorStoreGaussDB.node.test.ts`

- [ ] **Step 1: 写凭据（照 ChatHubVectorStorePGVectorApi，extends postgres + tableNamePrefix）**

```ts
import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ChatHubVectorStoreGaussDBApi implements ICredentialType {
	name = 'chatHubVectorStoreGaussDBApi';
	extends = ['postgres'];
	displayName = 'ChatHub GaussDB Store API';
	documentationUrl = 'postgres';
	properties: INodeProperties[] = [
		{
			displayName: 'Table Name Prefix', name: 'tableNamePrefix', type: 'string', default: 'n8n_vectors',
			description: 'Prefix for table names. The full table name will be {prefix}_{userId}.',
		},
	];
}
```

- [ ] **Step 2: 注册凭据到 package.json**

Modify: `packages/@n8n/nodes-langchain/package.json`，n8n.credentials 数组（ChatHubVectorStorePGVectorApi 在 :83）后加：
```json
"dist/credentials/ChatHubVectorStoreGaussDBApi.credentials.js",
```

- [ ] **Step 3: 写 ChatHub 节点（照 ChatHubVectorStorePGVector.node.ts，复用 GaussDBVectorStore + ChatHub 共享逻辑）**

参考 `packages/@n8n/nodes-langchain/nodes/vector_store/ChatHubVectorStorePGVector/ChatHubVectorStorePGVector.node.ts`，改：
- import `GaussDBVectorStore` from `../VectorStoreGaussDB/GaussDBVectorStore`
- import `getUserScopedSlot` from `../shared/userScoped`
- import `filterChatHubMetadata, filterChatHubInsertDocuments, CHAT_HUB_RETRIEVE_METADATA_KEYS` from `../shared/chatHub`
- `meta.name = 'chatHubVectorStoreGaussDB'`, `displayName = 'ChatHub GaussDB Store'`, `hidden: true`
- `credentials: [{ name: 'chatHubVectorStoreGaussDBApi', required: true, testedBy: 'chatHubVectorStoreGaussDBApiConnectionTest' }]`
- getVectorStoreClient：getCredentials('chatHubVectorStoreGaussDBApi') → getUserScopedSlot（用户级表） → configurePostgres → db.$pool → GaussDBVectorStore.initialize → 包装 similaritySearchVectorWithScore 加 filterChatHubMetadata
- populateVectorStore：加 filterChatHubInsertDocuments
- 凭据测试：不检查 pgvector 扩展，改为检查 `SHOW enable_vectordb`（=on）

- [ ] **Step 4: 写测试（NodeTestHarness + mock）**

参考 `ChatHubVectorStorePGVector.node.test.ts`，测用户级表隔离 + metadata 过滤。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/@n8n/nodes-langchain && pnpm test ChatHubVectorStoreGaussDB.node.test`
Expected: PASS

- [ ] **Step 6: 注册节点到 package.json**

Modify: `packages/@n8n/nodes-langchain/package.json`，n8n.nodes 数组（ChatHubVectorStorePGVector 在 :191）后加：
```json
"dist/nodes/vector_store/ChatHubVectorStoreGaussDB/ChatHubVectorStoreGaussDB.node.js",
```

- [ ] **Step 7: 标记完成**

---

## Task 15: 全量 typecheck + lint + 集成测试

**Files:** 无新增，验证

- [ ] **Step 1: nodes-base typecheck + lint**

Run: `cd packages/nodes-base && pnpm typecheck && pnpm lint`
Expected: 无错误

- [ ] **Step 2: nodes-langchain typecheck + lint**

Run: `cd packages/@n8n/nodes-langchain && pnpm typecheck && pnpm lint`
Expected: 无错误

- [ ] **Step 3: 全量测试**

Run: `cd packages/nodes-base && pnpm test GaussDb` + `cd packages/@n8n/nodes-langchain && pnpm test VectorStoreGaussDB`
Expected: 全 PASS

- [ ] **Step 4: 集成测试（连真实 GaussDB n8n_test 库）**

启动 n8n dev：`cd D:/workplace/code/n8n-stable && pnpm dev:ai`（AI 开发模式，含 nodes-langchain），在 UI：
1. C：加 GaussDb 凭据，建 workflow 执行 executeQuery/insert/select/update/deleteTable/upsert，确认 6 operation 跑通
2. B：加 postgres 凭据指向 GaussDB，建 VectorStoreGaussDB 节点，测 insert/load/retrieve，确认向量 CRUD + 检索 + score 正确
3. 确认 O模式适配（空串→NULL、id varchar(36) + uuid）

- [ ] **Step 5: 标记完成**

---

## Self-Review

**1. Spec 覆盖：**
- C 6 operation → Task 4-9（executeQuery/insert/update/select/deleteTable/upsert）✅
- C 凭据/transport/router/methods/主文件 → Task 1-3, 10-11 ✅
- B GaussDBVectorStore 核心 → Task 12 ✅
- B 标准节点 → Task 13 ✅
- B ChatHub 凭据+节点 → Task 14 ✅
- O模式适配（id varchar(36)+uuid/判空 IS NULL/jsonb）→ Task 12 ensureTable/addVectors ✅
- 自动探测（datcompatibility 形态 + 维度上限）→ Task 12 detectTopology/probeDimSupport/createIndex ✅
- score=1-distance → Task 12 similaritySearchVectorWithScore ✅
- maintenance_work_mem 带引号 → Task 12 createIndex ✅
- pq_nseg 算法 → Task 12 calcPqNseg ✅
- 全量 typecheck/lint/集成测试 → Task 15 ✅

**2. 占位符扫描：** Task 3/5-9 的 operation 实现用"参考 Postgres xxx.operation.ts"——这是合理的（复用 v1 genericFunctions，结构照搬），但 plan 要求"repeat the code"。这些 operation 文件结构与 Postgres 高度一致（只改 import 路径和节点名），实现时可逐行对照 Postgres 版本。Task 12 GaussDBVectorStore 给了完整代码。Task 13/14 节点骨架给了关键差异点。满足可执行性。

**3. 类型一致性：**
- `GaussDbNodeCredentials` / `GaussDbConnectionData`（Task 2 定义）在 Task 3 router / Task 10 credentialTest 引用一致 ✅
- `GaussDBVectorStore` / `GaussDBVectorStoreArgs`（Task 12 定义）在 Task 13/14 引用一致 ✅
- `indexType: 'auto'|'gsivfflat'|'gsdiskann'`（Task 12/13 一致）✅
- 凭据 name：`gaussDb`（C，Task 1）/ `chatHubVectorStoreGaussDBApi`（B ChatHub，Task 14）/ 复用 `postgres`（B 标准，Task 13）—— 一致 ✅

---

## 执行顺序提示

C 和 B 独立（不同包，不共享文件），可顺序或并行。建议：
- **C 先**（Task 1-11）：CrateDb 模式成熟，改造量小，快速见效
- **B 后**（Task 12-14）：GaussDBVectorStore 是核心，需仔细
- **Task 15 收尾**：全量验证

每个 Task 内 TDD：先写测试 → 跑失败 → 实现 → 跑通过 → 标记完成。Task 3 骨架会暂留 typecheck 错误（import 未实现的 operation），Task 4-9 逐个消除。
