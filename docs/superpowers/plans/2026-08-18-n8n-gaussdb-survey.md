# n8n 适配 GaussDB 调研实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出 n8n 适配 GaussDB 的实测驱动调研报告，摸清 C（数据库节点）+ B（向量节点）两个 P0 维度的可行性、改造点与风险，A 维度（主库）仅作记录。

**Architecture:** 对标 dify/survey 方法论。在 n8n 仓库根下建 `survey/` 工作区，`pyexp/` 放独立 TS 探针脚本（自己装 pg/pg-promise 依赖，不进 n8n 构建链），探针连真实 GaussDB 集中式实例（121.37.186.131:19995）跑实测，结论以实验编号回填进 `survey/n8n-gaussdb-调研报告.md`。C+B 为 P0 先行，A 为 P2 仅静态分析。

**Tech Stack:** TypeScript（探针）、node `pg` 11.x、`pg-promise` 11.9.1、GaussDB Kernel 507（集中式/O模式/enable_vectordb=on）、n8n 2.34.6 源码（静态分析对象）。

**依赖来源确认：** n8n monorepo 的 `packages/nodes-base/package.json:998-999` 已有 `pg`(catalog) + `pg-promise`@11.9.1。探针在独立 `survey/pyexp/` 目录自带 package.json，装同名版本，与 n8n 运行时一致。

**GaussDB 实例信息：**
- Host: `121.37.186.131`，Port: `19995`
- Kernel 507，O模式（DBCOMPATIBILITY='A'），enable_vectordb=on
- 集中式形态（当前已有实例）
- 凭据：执行时从用户处获取（写入 `.env` 不提交）

---

## 文件结构

```
survey/
├── pyexp/
│   ├── package.json              # 独立依赖：pg, pg-promise, dotenv, typescript, tsx
│   ├── tsconfig.json             # 探针 TS 配置
│   ├── .env.example              # GaussDB 连接配置模板（凭据占位）
│   ├── .env                      # 实际凭据（gitignore，执行时填）
│   ├── .gitignore                # 忽略 .env / *.log / node_modules
│   ├── conn.ts                   # 共享连接模块（读 .env，导出连接参数）
│   ├── exp_pg_promise.ts         # P0：pg-promise 连通性 + 查询（C/B 生死线）
│   ├── exp_pg_driver.ts          # P1：node pg 驱动连通性（B 辅助）
│   ├── exp_vector_crud.ts        # P0：floatvector 建表/插入/GsIVFFLAT/<+>/score/UPDATE/DELETE 全链路
│   ├── exp_pgvector_compat.ts    # P0：验证 pgvector 不兼容（vector类型/HNSW/<=>）
│   ├── exp_dim_centralized.ts    # P0：集中式维度上限（无PQ 1024? +PQ 4096?）
│   ├── exp_pq_index.ts           # P0：GsDiskANN+PQ 1536/3072/4096 维建索引+检索
│   └── *.log                     # 各探针输出日志（gitignore）
└── n8n-gaussdb-调研报告.md       # 最终调研报告（十章结构）
```

**职责边界：**
- `conn.ts`：唯一读 `.env` 的地方，所有探针 import 它拿连接参数。改凭据只改一处。
- 每个探针独立可跑（`tsx exp_xxx.ts`），互不依赖，输出写 `*.log`。
- 调研报告是唯一面向人的产出，探针结论以实验编号（如 `N-EXP-01`）回填进报告证据索引。

---

## Task 1: 搭建 survey/pyexp 探针骨架

**Files:**
- Create: `survey/pyexp/package.json`
- Create: `survey/pyexp/tsconfig.json`
- Create: `survey/pyexp/.env.example`
- Create: `survey/pyexp/.gitignore`
- Create: `survey/pyexp/conn.ts`

- [ ] **Step 1: 建 package.json**

```json
{
  "name": "n8n-gaussdb-pyexp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "exp:pg-promise": "tsx exp_pg_promise.ts",
    "exp:pg-driver": "tsx exp_pg_driver.ts",
    "exp:vector-crud": "tsx exp_vector_crud.ts",
    "exp:pgvector-compat": "tsx exp_pgvector_compat.ts",
    "exp:dim-centralized": "tsx exp_dim_centralized.ts",
    "exp:pq-index": "tsx exp_pq_index.ts"
  },
  "dependencies": {
    "pg": "^8.13.0",
    "pg-promise": "11.9.1",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "@types/pg": "^8.11.10"
  }
}
```

- [ ] **Step 2: 建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["*.ts"]
}
```

- [ ] **Step 3: 建 .env.example**

```env
# GaussDB 集中式实例（与 dify survey 同一实例）
GAUSSDB_HOST=121.37.186.131
GAUSSDB_PORT=19995
GAUSSDB_USER=填实际用户名
GAUSSDB_PASSWORD=填实际密码
GAUSSDB_DATABASE=填测试库名
```

- [ ] **Step 4: 建 .gitignore**

```gitignore
node_modules/
.env
*.log
```

- [ ] **Step 5: 建 conn.ts（共享连接模块）**

```ts
import dotenv from 'dotenv';
dotenv.config();

export const conn = {
  host: process.env.GAUSSDB_HOST!,
  port: Number(process.env.GAUSSDB_PORT!),
  user: process.env.GAUSSDB_USER!,
  password: process.env.GAUSSDB_PASSWORD!,
  database: process.env.GAUSSDB_DATABASE!,
};

export const connStr =
  `postgres://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${conn.database}`;

// 统一日志写入：stdout + 追加文件
import { appendFileSync } from 'node:fs';
export function log(name: string, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(`${name}.log`, line + '\n');
}
```

- [ ] **Step 6: 安装依赖**

Run: `cd survey/pyexp && pnpm install`
Expected: 安装成功，生成 node_modules。

- [ ] **Step 7: 填 .env（凭据从用户处获取，不提交）**

执行人向用户索取 GaussDB 凭据，填入 `survey/pyexp/.env`（已被 gitignore）。
验证：`pnpm exp:pg-promise` 能读到配置（连不上是后续探针的事，此步只验证配置加载）。

- [ ] **Step 8: Commit**

```bash
git add survey/pyexp/package.json survey/pyexp/tsconfig.json survey/pyexp/.env.example survey/pyexp/.gitignore survey/pyexp/conn.ts
git commit -m "chore: scaffold gaussdb survey pyexp probes"
```

---

## Task 2: P0 探针 exp_pg_promise（C/B 生死线）

**Files:**
- Create: `survey/pyexp/exp_pg_promise.ts`

**目的：** 验证 `pg-promise`（n8n Postgres 节点/PGVector 节点用的驱动）能否连 GaussDB + 执行查询。这是 C 维度（数据库节点）和 B 维度（向量节点复用 pg-promise pool）的共同生死线。dify 测的是 Python psycopg2，node pg-promise 未测过。

- [ ] **Step 1: 写探针脚本**

```ts
import pgPromise from 'pg-promise';
import { conn, log } from './conn';

const pgp = pgPromise({});
const db = pgp(`postgres://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${conn.database}`);

const NAME = 'exp_pg_promise';
const tag = (n: string) => `N-EXP-02 ${n}`;

async function main() {
  try {
    const ver = await db.one('SELECT version() AS v');
    log(NAME, tag('connect-ok') + ' version=' + ver.v.slice(0, 80));
  } catch (e: any) {
    log(NAME, tag('connect-fail') + ' error=' + e.message);
    process.exitCode = 1;
    return;
  }

  try {
    const compat = await db.one("SELECT datcompatibility FROM pg_database WHERE datname = $1", conn.database);
    log(NAME, tag('compat-ok') + ' datcompatibility=' + compat.datcompatibility);
  } catch (e: any) {
    log(NAME, tag('compat-fail') + ' error=' + e.message);
  }

  try {
    const vdb = await db.one('SHOW enable_vectordb');
    log(NAME, tag('vectordb-guc') + ' enable_vectordb=' + vdb.enable_vectordb);
  } catch (e: any) {
    log(NAME, tag('vectordb-fail') + ' error=' + e.message);
  }

  try {
    const rows = await db.any('SELECT 1 AS n');
    log(NAME, tag('query-ok') + ' rows=' + JSON.stringify(rows));
  } catch (e: any) {
    log(NAME, tag('query-fail') + ' error=' + e.message);
    process.exitCode = 1;
  }

  await pgp.end();
}
main();
```

- [ ] **Step 2: 跑探针**

Run: `cd survey/pyexp && pnpm exp:pg-promise`
Expected: 生成 `exp_pg_promise.log`，含 connect-ok/compat-ok/vectordb-guc/query-ok 四行。若 connect-fail 或 query-fail，记录 error 供报告诊断。

- [ ] **Step 3: 记录结论到报告草稿**

在 `survey/n8n-gaussdb-调研报告.md`（此时可能尚未建，先记到临时 `survey/notes.md`）记录：
- `N-EXP-02 connect-ok`：pg-promise 直连 GaussDB 成功/失败 + version 字符串
- `N-EXP-02 compat-ok`：datcompatibility 值（预期 'A'）
- `N-EXP-02 vectordb-guc`：enable_vectordb 值（预期 on）

- [ ] **Step 4: Commit**

```bash
git add survey/pyexp/exp_pg_promise.ts survey/pyexp/exp_pg_promise.log survey/notes.md
git commit -m "exp: pg-promise connectivity probe (C/B lifeline)"
```

---

## Task 3: P0 探针 exp_vector_crud（B 向量全链路）

**Files:**
- Create: `survey/pyexp/exp_vector_crud.ts`

**目的：** 验证 GaussDB 向量 API 全链路（floatvector 建表/插入/GsIVFFLAT 索引/`<+>` 检索/score=1-dist/UPDATE/DELETE）。复用 dify `exp_vector_crud.py` 的 SQL（向量 SQL 与客户端语言无关），用 pg-promise 重跑确认同一实例仍可用。

- [ ] **Step 1: 写探针脚本**

```ts
import pgPromise from 'pg-promise';
import { conn, log } from './conn';

const pgp = pgPromise({});
const db = pgp(`postgres://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${conn.database}`);
const NAME = 'exp_vector_crud';
const tag = (n: string) => `N-EXP-03 ${n}`;
const TBL = 'n8n_pyexp_vec_crud';

async function main() {
  // 前置：清理旧表
  await db.none('DROP TABLE IF EXISTS $1:name', [TBL]).catch(() => {});

  // 1. 建表（floatvector(3)）
  try {
    await db.none(`CREATE TABLE $1:name (id int PRIMARY KEY, text text, embedding floatvector(3) NOT NULL)`, [TBL]);
    log(NAME, tag('create-table-ok') + ' floatvector(3)');
  } catch (e: any) { log(NAME, tag('create-table-fail') + ' ' + e.message); process.exitCode = 1; return; }

  // 2. 插入（字符串字面量 '[x,y,z]'）
  try {
    await db.none(`INSERT INTO $1:name VALUES (1,'hello','[0.1,0.2,0.3]'), (2,'world','[0.4,0.5,0.6]'), (3,'foo','[0.9,0.0,0.1]')`, [TBL]);
    log(NAME, tag('insert-ok'));
  } catch (e: any) { log(NAME, tag('insert-fail') + ' ' + e.message); process.exitCode = 1; return; }

  // 3. 建 GsIVFFLAT 索引
  try {
    await db.none(`CREATE INDEX ON $1:name USING gsivfflat (embedding cosine) WITH (ivf_nlist = 10)`, [TBL]);
    log(NAME, tag('ivfflat-idx-ok'));
  } catch (e: any) { log(NAME, tag('ivfflat-idx-fail') + ' ' + e.message); }

  // 4. 检索（<+> 余弦距离，仅 ORDER BY col <+> vec LIMIT k 走索引）
  try {
    const rows = await db.any(`SELECT id, text, embedding <+> '[0.1,0.2,0.3]' AS distance FROM $1:name ORDER BY distance LIMIT 2`, [TBL]);
    const scored = rows.map((r: any) => ({ id: r.id, score: 1 - Number(r.distance), dist: r.distance }));
    log(NAME, tag('search-ok') + ' ' + JSON.stringify(scored));
    // 预期 id=1 的 score=1.0（distance=0）
    const hit = scored.find((s: any) => s.id === 1);
    if (hit && Math.abs(hit.score - 1.0) < 0.001) log(NAME, tag('score-formula-ok') + ' id=1 score≈1.0');
    else log(NAME, tag('score-formula-warn') + ' id=1 score=' + hit?.score);
  } catch (e: any) { log(NAME, tag('search-fail') + ' ' + e.message); process.exitCode = 1; }

  // 5. UPDATE
  try {
    await db.none(`UPDATE $1:name SET embedding = '[0.2,0.2,0.2]' WHERE id = 2`, [TBL]);
    log(NAME, tag('update-ok'));
  } catch (e: any) { log(NAME, tag('update-fail') + ' ' + e.message); }

  // 6. DELETE
  try {
    await db.none(`DELETE FROM $1:name WHERE id = 3`, [TBL]);
    const cnt = await db.one(`SELECT count(*) AS c FROM $1:name`, [TBL]);
    log(NAME, tag('delete-ok') + ' count=' + cnt.c);
  } catch (e: any) { log(NAME, tag('delete-fail') + ' ' + e.message); }

  await pgp.end();
}
main();
```

- [ ] **Step 2: 跑探针**

Run: `cd survey/pyexp && pnpm exp:vector-crud`
Expected: `exp_vector_crud.log` 含 create-table-ok / insert-ok / ivfflat-idx-ok / search-ok / score-formula-ok / update-ok / delete-ok 全绿。任一 fail 记录原因。

- [ ] **Step 3: 记录结论到 notes.md**

- `N-EXP-03`：floatvector/GsIVFFLAT/`<+>`/score=1-dist/UPDATE/DELETE 全链路结果（预期全 go，复用 dify 结论）

- [ ] **Step 4: Commit**

```bash
git add survey/pyexp/exp_vector_crud.ts survey/pyexp/exp_vector_crud.log survey/notes.md
git commit -m "exp: vector crud full chain probe (B)"
```

---

## Task 4: P0 探针 exp_pgvector_compat（B 决策依据）

**Files:**
- Create: `survey/pyexp/exp_pgvector_compat.ts`

**目的：** 实测确认 GaussDB 不兼容 pgvector（`vector` 类型 / HNSW 索引 / `<=>` 算子）。这决定 n8n 现有 PGVector 节点能否直接指向 GaussDB——若不兼容（预期），必须自建 GaussDB 向量节点。

- [ ] **Step 1: 写探针脚本**

```ts
import pgPromise from 'pg-promise';
import { conn, log } from './conn';

const pgp = pgPromise({});
const db = pgp(`postgres://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${conn.database}`);
const NAME = 'exp_pgvector_compat';
const tag = (n: string) => `N-EXP-04 ${n}`;

async function probe(label: string, sql: string) {
  try {
    await db.none(sql);
    log(NAME, tag(label + '-present') + ' SQL=' + sql.slice(0, 60));
  } catch (e: any) {
    // 预期：类型/算子不存在报错 = 不兼容 = 符合预期
    log(NAME, tag(label + '-absent') + ' err=' + e.message.slice(0, 80));
  }
}

async function main() {
  await db.none('DROP TABLE IF EXISTS n8n_pyexp_pgvec_test').catch(() => {});

  // 1. pgvector 的 vector 类型
  await probe('type-vector', `CREATE TABLE n8n_pyexp_pgvec_test (id int, v vector(3))`);

  // 2. HNSW 索引（pgvector 特有）
  await probe('idx-hnsw', `CREATE INDEX ON n8n_pyexp_pgvec_test USING hnsw (v vector_cosine_ops)`);

  // 3. <=> 算子（pgvector 余弦相似度）
  try {
    await db.none(`INSERT INTO n8n_pyexp_pgvec_test VALUES (1, '[1,2,3]')`);
    await db.any(`SELECT v <=> '[1,2,3]' FROM n8n_pyexp_pgvec_test`);
    log(NAME, tag('op-cosine-present'));
  } catch (e: any) {
    log(NAME, tag('op-cosine-absent') + ' err=' + e.message.slice(0, 80));
  }

  await db.none('DROP TABLE IF EXISTS n8n_pyexp_pgvec_test').catch(() => {});
  await pgp.end();
}
main();
```

- [ ] **Step 2: 跑探针**

Run: `cd survey/pyexp && pnpm exp:pgvector-compat`
Expected: `exp_pgvector_compat.log` 全部 `-absent`（type-vector-absent / idx-hnsw-absent / op-cosine-absent），确认 pgvector 三项全不兼容。若有任一 present，记录（可能该实例装了 pgvector 扩展，影响结论）。

- [ ] **Step 3: 记录结论到 notes.md**

- `N-EXP-04`：pgvector 兼容性——预期 vector类型/HNSW/`<=>` 三项全 absent → PGVector 节点不可复用，需自建 GaussDB 向量节点

- [ ] **Step 4: Commit**

```bash
git add survey/pyexp/exp_pgvector_compat.ts survey/pyexp/exp_pgvector_compat.log survey/notes.md
git commit -m "exp: pgvector incompatibility probe (B decision)"
```

---

## Task 5: P0 探针 exp_dim_centralized（B 维度约束）

**Files:**
- Create: `survey/pyexp/exp_dim_centralized.ts`

**目的：** 实测集中式实例的维度上限。dify 记"该实例 1024"，但 dify 未测 GsDiskANN+PQ 路径。本探针测两件事：① GsIVFFLAT/GsDiskANN（无 PQ）的上限（预期 1024）；② GsDiskANN+PQ 能否突破到 4096（这是 n8n 覆盖 ≤4096 维的关键）。

- [ ] **Step 1: 写探针脚本**

```ts
import pgPromise from 'pg-promise';
import { conn, log } from './conn';

const pgp = pgPromise({});
const db = pgp(`postgres://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${conn.database}`);
const NAME = 'exp_dim_centralized';
const tag = (n: string) => `N-EXP-05 ${n}`;

async function tryDim(method: string, dim: number, buildIdx: (tbl: string, dim: number) => string) {
  const tbl = `n8n_pyexp_dim_${method}_${dim}`;
  await db.none(`DROP TABLE IF EXISTS $1:name`, [tbl]).catch(() => {});
  try {
    await db.none(`CREATE TABLE $1:name (id int, embedding floatvector($2) NOT NULL)`, [tbl, dim]);
    await db.none(`INSERT INTO $1:name VALUES (1, array_to_string(ARRAY(SELECT 0.1 FROM generate_series(1,$2)), ',')::floatvector)`, [tbl, dim]).catch(() => {});
    await db.none(buildIdx(tbl, dim));
    log(NAME, tag('dim-ok') + ` method=${method} dim=${dim}`);
    await db.none(`DROP TABLE $1:name`, [tbl]).catch(() => {});
    return true;
  } catch (e: any) {
    log(NAME, tag('dim-fail') + ` method=${method} dim=${dim} err=` + e.message.slice(0, 100));
    await db.none(`DROP TABLE IF EXISTS $1:name`, [tbl]).catch(() => {});
    return false;
  }
}

async function main() {
  // GsIVFFLAT 上限：测 1024 / 1536 / 4096
  for (const d of [1024, 1536, 4096]) {
    await tryDim('ivfflat', d, (t) => `CREATE INDEX ON ${t} USING gsivfflat (embedding cosine) WITH (ivf_nlist=10)`);
  }
  // GsDiskANN 无 PQ 上限：测 1024 / 4096
  for (const d of [1024, 4096]) {
    await tryDim('diskann-nopq', d, (t) => `CREATE INDEX ON ${t} USING gsdiskann (embedding cosine)`);
  }
  await pgp.end();
}
main();
```

> 注意：`array_to_string` 构造向量字面量是简化写法，若 GaussDB 不接受可改用 pg-promise 的参数化。先按此跑，fail 时据错误信息调整（记录在 log）。

- [ ] **Step 2: 跑探针**

Run: `cd survey/pyexp && pnpm exp:dim-centralized`
Expected: `exp_dim_centralized.log` 显示：
- ivfflat: 1024 ok / 1536 fail / 4096 fail（GsIVFFLAT 上限 1024）
- diskann-nopq: 1024 ok / 4096 可能 fail（无 PQ 时上限 1024）

- [ ] **Step 3: 记录结论到 notes.md**

- `N-EXP-05`：GsIVFFLAT 上限（预期 1024）/ GsDiskANN 无 PQ 上限（预期 1024）。>1024 维是否必须 PQ，留 Task 6 的 exp_pq_index 验证。

- [ ] **Step 4: Commit**

```bash
git add survey/pyexp/exp_dim_centralized.ts survey/pyexp/exp_dim_centralized.log survey/notes.md
git commit -m "exp: centralized dimension limit probe (B constraint)"
```

---

## Task 6: P0 探针 exp_pq_index（B 的 4096 维关键路径）

**Files:**
- Create: `survey/pyexp/exp_pq_index.ts`

**目的：** 验证 GsDiskANN+PQ 能否跑通 >1024 维（1536/3072/4096）的建索引 + 检索。dify 只描述了 `pq_nseg` 算法没实测，这是 n8n 覆盖 ≤4096 维的决定性实验。`pq_nseg` 须整除维度：1536→96，3072→96/192，4096→256。

- [ ] **Step 1: 写探针脚本**

```ts
import pgPromise from 'pg-promise';
import { conn, log } from './conn';

const pgp = pgPromise({});
const db = pgp(`postgres://${conn.user}:${conn.password}@${conn.host}:${conn.port}/${conn.database}`);
const NAME = 'exp_pq_index';
const tag = (n: string) => `N-EXP-06 ${n}`;

// pq_nseg 须整除维度
function pqNseg(dim: number): number {
  if (dim <= 512) return dim;
  if (dim <= 1024) return dim / 2;
  // >1024：取能整除的合适值
  const candidates = [96, 128, 192, 256, 384];
  for (const c of candidates) if (dim % c === 0) return c;
  return dim / 4;
}

async function tryPq(dim: number) {
  const tbl = `n8n_pyexp_pq_${dim}`;
  const nseg = pqNseg(dim);
  await db.none(`DROP TABLE IF EXISTS $1:name`, [tbl]).catch(() => {});
  try {
    // 建表
    await db.none(`CREATE TABLE $1:name (id int, embedding floatvector($2) NOT NULL)`, [tbl, dim]);
    // 插入若干零向量（简化，用字符串字面量）
    const lit = '[' + Array(dim).fill(0.1).join(',') + ']';
    await db.none(`INSERT INTO $1:name VALUES (1, $2::floatvector)`, [tbl, lit]);
    // GsDiskANN+PQ 索引
    await db.none(
      `CREATE INDEX ON $1:name USING gsdiskann (embedding cosine) WITH (pq_nseg=$2, pq_nclus=16, enable_pq=true, subgraph_count=1, enable_vector_copy=false)`,
      [tbl, nseg]
    );
    log(NAME, tag('pq-idx-ok') + ` dim=${dim} pq_nseg=${nseg}`);
    // 检索
    const rows = await db.any(`SELECT id, embedding <+> $1::floatvector AS dist FROM $2:name ORDER BY dist LIMIT 1`, [lit, tbl]);
    log(NAME, tag('pq-search-ok') + ` dim=${dim} dist=` + rows[0]?.dist);
  } catch (e: any) {
    log(NAME, tag('pq-fail') + ` dim=${dim} pq_nseg=${nseg} err=` + e.message.slice(0, 120));
  }
  await db.none(`DROP TABLE IF EXISTS $1:name`, [tbl]).catch(() => {});
}

async function main() {
  for (const d of [1536, 3072, 4096]) await tryPq(d);
  await pgp.end();
}
main();
```

- [ ] **Step 2: 跑探针**

Run: `cd survey/pyexp && pnpm exp:pq-index`
Expected: `exp_pq_index.log` 显示 1536/3072/4096 各自 pq-idx-ok + pq-search-ok，或 pq-fail 含原因。若 4096 fail，记录错误（可能该集中式实例 PQ 也有上限，或 `pq_nseg` 算法需调）。

- [ ] **Step 3: 记录结论到 notes.md**

- `N-EXP-06`：GsDiskANN+PQ 在 1536/3072/4096 维的建索引+检索结果。这是 n8n B 维度覆盖 ≤4096 维的依据。若全 ok → B 支持 ≤4096 维；若 4096 fail → B 上限标实测值，报告如实记录。

- [ ] **Step 4: Commit**

```bash
git add survey/pyexp/exp_pq_index.ts survey/pyexp/exp_pq_index.log survey/notes.md
git commit -m "exp: gsdiskann+pq high-dim probe (B 4096 path)"
```

---

## Task 7: P1 探针 exp_pg_driver（B 辅助）

**Files:**
- Create: `survey/pyexp/exp_pg_driver.ts`

**目的：** 验证 node `pg` 驱动（LangChain PGVectorStore 底层用）直连 GaussDB。B 维度若复用 LangChain PGVectorStore 框架会用到 pg pool，需确认连通。优先级低于 pg-promise（C/B 主驱动），作为辅助证据。

- [ ] **Step 1: 写探针脚本**

```ts
import { Client } from 'pg';
import { conn, log } from './conn';

const NAME = 'exp_pg_driver';
const tag = (n: string) => `N-EXP-01 ${n}`;

async function main() {
  const client = new Client({
    host: conn.host, port: conn.port,
    user: conn.user, password: conn.password, database: conn.database,
  });
  try {
    await client.connect();
    const res = await client.query('SELECT version() AS v');
    log(NAME, tag('connect-ok') + ' version=' + res.rows[0].v.slice(0, 80));
    const res2 = await client.query('SELECT 1 AS n');
    log(NAME, tag('query-ok') + ' ' + JSON.stringify(res2.rows));
  } catch (e: any) {
    log(NAME, tag('connect-fail') + ' err=' + e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
main();
```

- [ ] **Step 2: 跑探针**

Run: `cd survey/pyexp && pnpm exp:pg-driver`
Expected: `exp_pg_driver.log` 含 connect-ok + query-ok，或 connect-fail + 原因。

- [ ] **Step 3: 记录结论到 notes.md**

- `N-EXP-01`：node pg 驱动连通性（B 辅助）

- [ ] **Step 4: Commit**

```bash
git add survey/pyexp/exp_pg_driver.ts survey/pyexp/exp_pg_driver.log survey/notes.md
git commit -m "exp: node pg driver connectivity probe (B auxiliary)"
```

---

## Task 8: 静态分析 C 维度（GaussDB 数据库节点）

**目的：** 不写代码，读 n8n 源码摸清 C 维度改造点，为报告第五章准备证据。重点：Postgres v2 节点结构、CrateDb 复用模式、凭据、节点注册。

**Files:** 仅读取，不改。

- [ ] **Step 1: 读 Postgres v2 节点结构**

Read: `packages/nodes-base/nodes/Postgres/v2/PostgresV2.node.ts`、`packages/nodes-base/nodes/Postgres/v2/actions/router.ts`、`packages/nodes-base/nodes/Postgres/transport/index.ts`
记录：节点如何实现 INodeType、`configurePostgres` 如何初始化 pg-promise、操作路由结构。

- [ ] **Step 2: 读 CrateDb 复用模式**

Read: `packages/nodes-base/nodes/CrateDb/CrateDb.node.ts`
记录：CrateDB 如何复用 `Postgres/v1/genericFunctions`（pgInsert/pgQueryV2/pgUpdate）、`sqlDialect: 'PostgreSQL'`。这是 GaussDB 节点的参考模板。

- [ ] **Step 3: 读 Postgres 凭据定义**

Read: `packages/nodes-base/credentials/Postgres.credentials.ts`、`packages/nodes-base/nodes/Postgres/v2/helpers/interfaces.ts`
记录：凭据字段（host/port/database/user/password/maxConnections/ssl/sshTunnel）、`PostgresNodeCredentials` 接口。

- [ ] **Step 4: 读节点注册机制**

Read: `packages/nodes-base/package.json`（nodes 数组约 :442，credentials 数组约 :36）、`packages/nodes-base/AGENTS.md`
记录：新节点如何注册到 nodes/credentials 数组、新建节点规范。

- [ ] **Step 5: 汇总 C 维度改造点清单**

在 `survey/notes.md` 记录 C 维度结论：
- 新建 `packages/nodes-base/nodes/GaussDb/GaussDb.node.ts`（实现 INodeType，`sqlDialect: 'PostgreSQL'`）
- 新建 `packages/nodes-base/credentials/GaussDb.credentials.ts`（照 Postgres.credentials.ts，字段同）
- transport：用 pg-promise 连 GaussDB（PG 线协议），可复用 `configurePostgres` 或写 `configureGaussDb`
- operations：复用 `Postgres/v1/genericFunctions`（pgInsert/pgQueryV2/pgUpdate，参考 CrateDb）
- 注册：package.json nodes + credentials 数组各加一行
- go/no-go：取决于 `N-EXP-02` pg-promise 连通性（Task 2）

- [ ] **Step 6: Commit**

```bash
git add survey/notes.md
git commit -m "survey: static analysis C dimension (gaussdb node)"
```

---

## Task 9: 静态分析 B 维度（GaussDB 向量节点）

**目的：** 读 n8n 源码摸清 B 维度改造点，为报告第四章准备证据。重点：PGVector 节点机制、createVectorStoreNode 工厂、floatvector SQL 适配对照。

**Files:** 仅读取，不改。

- [ ] **Step 1: 读 PGVector 节点**

Read: `packages/@n8n/nodes-langchain/nodes/vector_store/VectorStorePGVector/VectorStorePGVector.node.ts`
记录：如何 import LangChain PGVectorStore、如何复用 `configurePostgres`、`ExtendedPGVectorStore` 如何重写 `similaritySearchVectorWithScore`、`getVectorStoreClient` 如何构造、默认表/列名（`n8n_vectors`/`embedding`/`text`/`metadata`）。

- [ ] **Step 2: 读 createVectorStoreNode 工厂**

Read: `packages/@n8n/ai-utilities/src/utils/vector-store/createVectorStoreNode/createVectorStoreNode.ts`
记录：工厂签名 `createVectorStoreNode(args)`、`VectorStoreNodeConstructorArgs` 结构（meta/sharedFields/getVectorStoreClient/populateVectorStore）、5 种 mode（insert/load/retrieve/retrieve-as-tool/update）。

- [ ] **Step 3: 读向量节点列表**

Glob: `packages/@n8n/nodes-langchain/nodes/vector_store/*`
记录：23 个向量节点目录，确认无 GaussDB 节点。

- [ ] **Step 4: 汇总 B 维度改造点 + SQL 适配对照**

在 `survey/notes.md` 记录 B 维度结论：
- 自建 `packages/@n8n/nodes-langchain/nodes/vector_store/VectorStoreGaussDB/`（参考 VectorStorePGVector 结构 + createVectorStoreNode 工厂）
- SQL 适配对照（PGVector → GaussDB）：`vector(dim)`→`floatvector(dim)`、`hnsw`→`gsivfflat`/`gsdiskann`、`<=>`→`<+>`、score=1-dist 相同、`SET hnsw_earlystop_threshold`→`SET gsivfflat_probes`
- 索引选择逻辑（维度+形态双因素，见 spec 第 4 节表）
- go/no-go：向量 SQL 复用 `N-EXP-03`（Task 3 全 go）；pgvector 不兼容 `N-EXP-04`（Task 4 全 absent）→ 需自建节点；4096 维路径取决于 `N-EXP-06`（Task 6）

- [ ] **Step 5: Commit**

```bash
git add survey/notes.md
git commit -m "survey: static analysis B dimension (gaussdb vector node)"
```

---

## Task 10: 静态分析 A 维度（主库，P2 简化记录）

**目的：** A 维度非本次目标，仅作记录性陈述。读源码摸清 DB_TYPE 枚举、TypeORM 驱动、迁移机制，不排实测探针（P2 可选，本次不跑）。

**Files:** 仅读取，不改。

- [ ] **Step 1: 读 DB_TYPE 枚举与切换**

Read: `packages/@n8n/config/src/configs/database.config.ts:140-141,160-268`、`packages/@n8n/db/src/connection/db-connection-options.ts:34-44`
记录：`z.enum(['sqlite','postgresdb'])`、switch default 抛 UserError。

- [ ] **Step 2: 读迁移机制与 advisory lock**

Read: `packages/@n8n/db/src/connection/db-connection.ts:107-133`（migrateWithAdvisoryLock）、`packages/@n8n/db/src/migrations/migration-types.ts:6`
记录：迁移依赖 pg_advisory_lock；迁移分 common/postgresdb/sqlite；DatabaseType = 'postgresdb'|'sqlite'。

- [ ] **Step 3: 汇总 A 维度记录性结论**

在 `survey/notes.md` 记录 A 维度（P2，非本次目标）：
- 现状：DB_TYPE 只支持 sqlite/postgresdb，无 MySQL
- 最大未知（未实测）：TypeORM postgres 驱动能否连 GaussDB + 跑迁移（dify 用 SQLAlchemy 有 opengauss 方言，TypeORM 无）
- 结论走向：乐观=改枚举+验证迁移；悲观=需 fork @n8n/typeorm。**本次不实测，标"待 A 启动时补强"**
- 主库随附 Agent 记忆表：`agents_memory_entries` 用 JSON 列存 embedding（不依赖 pgvector），随 A 迁移，本次随 A 略过

- [ ] **Step 4: Commit**

```bash
git add survey/notes.md
git commit -m "survey: static analysis A dimension (P2 record-only)"
```

---

## Task 11: 写调研报告

**Files:**
- Create: `survey/n8n-gaussdb-调研报告.md`
- Delete: `survey/notes.md`（结论已并入报告）

**目的：** 综合所有探针实测结论（N-EXP-01~06）+ 三维度静态分析，产出最终调研报告（十章结构，对标 dify 调研报告）。

- [ ] **Step 1: 写报告十章**

按 spec 第二章章节结构表，把 `survey/notes.md` 的所有结论 + 探针 log 证据写入 `survey/n8n-gaussdb-调研报告.md`：

1. **调研背景**：n8n 2.34.6 + GaussDB V2.0-26.861.0，三维度 + 主库随附定义 + 使用场景（智数查询/RAG）
2. **结论速览**：三维度 go/no-go 一表（C/B 标 P0，A 标 P2）
3. **数据库节点（C）**：Postgres v2/pg-promise/CrateDb 复用模式/GaussDB 节点设计 + `N-EXP-02` 证据
4. **向量节点（B）**：PGVector 节点机制/createVectorStoreNode 工厂/floatvector 适配/集中式索引选择/PQ 算法 + `N-EXP-03/04/05/06` 证据
5. **驱动与兼容性**：pg-promise + node pg 两套客户端 + `N-EXP-01/02` 证据
6. **关系型主库（A）**：简化记录，标"非本次目标"，DB_TYPE/TypeORM/advisory lock 静态陈述
7. **主库随附：Agent 记忆表**：随 A 降级略过，仅一句"JSON 列存 embedding，不涉向量能力，随 A 迁移"
8. **配置位置索引**：节点注册/凭据/PostgresConfig 等关键文件:行号表
9. **适配建议**：C+B 重点建议 + A 留档 + 风险矩阵 + 范围取舍提示（留 spec 阶段）
10. **证据索引**：源码文件:行号 / chm 文档 / N-EXP 编号对照表

每条结论标注证据来源。C+B 的 go/no-go 由探针实测驱动；A 不给 go/no-go，标"待 A 启动时实测"。

- [ ] **Step 2: 自检报告完整性**

检查：
- 三维度是否都有结论（C/B go/no-go + 改造点；A 记录性陈述）
- 每个探针编号（N-EXP-01~06）是否在证据索引章有对应条目
- pgvector 不兼容结论是否明确写明"PGVector 节点不可复用，需自建 GaussDB 向量节点"
- 4096 维路径结论是否如实写明（取决于 N-EXP-06 实测结果，不预设）
- A 维度是否明确标"非本次目标，待 A 启动时实测补强"

- [ ] **Step 3: 删除临时 notes.md**

```bash
git rm survey/notes.md
```

- [ ] **Step 4: Commit**

```bash
git add survey/n8n-gaussdb-调研报告.md
git commit -m "docs: n8n gaussdb survey report (C+B P0, A P2 record-only)"
```

---

## Self-Review

**1. Spec 覆盖：**
- C 维度（数据库节点）→ Task 2（pg-promise 生死线）+ Task 8（静态分析）✅
- B 维度（向量节点）→ Task 3（vector crud）+ Task 4（pgvector 不兼容）+ Task 5（维度上限）+ Task 6（PQ 4096）+ Task 7（pg 驱动）+ Task 9（静态分析）✅
- A 维度（主库，P2）→ Task 10（静态分析，不实测）✅
- 调研报告产出 → Task 11 ✅
- 探针骨架 → Task 1 ✅
- spec 所有章节在报告里都有对应 → Task 11 章节结构 = spec 第二章表 ✅

**2. 占位符扫描：** 无 TBD/TODO。每个探针含完整可跑代码，每个静态分析任务含确切文件:行号。

**3. 类型一致性：** 探针实验编号 N-EXP-01（pg_driver）~ N-EXP-06（pq_index）在 Task 2-7 定义、Task 11 引用，编号一致。conn.ts 的 `conn`/`connStr`/`log` 在所有探针 import 一致。`pqNseg` 函数在 Task 6 定义并使用。

---

## 执行顺序提示

P0 探针有依赖关系：Task 2（pg-promise 连通性）是 C/B 共同生死线，**必须最先跑**——若 fail，C/B 维度结论直接 no-go，后续探针也连不上库。建议顺序：Task 1 → Task 2 →（Task 2 通过后）Task 3/4/5/6/7 并行 → Task 8/9/10 静态分析并行 → Task 11 汇总报告。
