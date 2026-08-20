#!/usr/bin/env python3
"""
L4 测试：GaussDB 向量能力（SQL 契约层）
从 .env.test 读配置，无需手改。不依赖 tsx / n8n 源码，纯 psycopg2 直连 GaussDB。

覆盖 4 组：
  1. 向量 CRUD：floatvector 建表 + 字符串字面量插入 + GsIVFFLAT 索引 + <+> 检索 + score=1-dist + UPDATE/DELETE
  2. 维度上限：GsIVFFLAT / GsDiskANN(无PQ) 在 1024/1536/4096 维建索引
  3. GsDiskANN+PQ 高维：1536/3072/4096 维 + pq_nseg 整除 + 检索
  4. 向量边界：空结果 filter / 超大 top-k / 零向量检索

说明：
  - 本脚本测 GaussDB 向量 SQL 契约层（GaussDB 向量能力本身）。
  - 节点代码逻辑层（buildFilterClauses / delete by filter 等）由单元测试覆盖（34 用例）。
  - 端到端集成由 n8n UI 手动测（见测试指南.md L4 方式二）。
  - pq_nseg 算法与节点 GaussDBVectorStore.calcPqNseg 完全一致，保证测的是节点实际会发的参数。
  - 自动探测集中式/分布式：集中式测到 4096 维；分布式 >1024 维跳过（SKIP，不 FAIL）。

依赖：pip install psycopg2-binary
用法：
  python3 test_vector.py            # 跑全部 4 组
  python3 test_vector.py --group 1  # 只跑第 1 组（CRUD）
  python3 test_vector.py --group 3  # 只跑第 3 组（PQ 高维，较慢）

自动化/CI：
  exit 0 = 全通过；exit 1 = 有失败。
  可串入 run_all.sh：./run_all.sh  # L2 连通 + L3 数据库节点 + L4 向量 一键跑
"""
import os
import sys

# Windows 终端默认 GBK，打印 ✓/✗ 会 UnicodeEncodeError，强制 UTF-8
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# 加载 .env.test
env_file = os.path.join(os.path.dirname(__file__), '.env.test')
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ[k.strip()] = v.strip()

try:
    import psycopg2
except ImportError:
    print("✗ 请先安装: pip install psycopg2-binary")
    sys.exit(1)

HOST = os.environ.get('GAUSSDB_HOST', 'localhost')
PORT = int(os.environ.get('GAUSSDB_PORT', '5432'))
USER = os.environ.get('GAUSSDB_USER', 'appuser')
PASSWORD = os.environ.get('GAUSSDB_PASSWORD', '')
DATABASE = os.environ.get('GAUSSDB_DATABASE', 'n8n_test')

passed = 0
failed = 0
skipped = 0

def check(name, condition, detail=''):
    global passed, failed
    if condition:
        print(f"  ✓ {name} {detail}")
        passed += 1
    else:
        print(f"  ✗ {name} {detail}")
        failed += 1

def skip(name, detail=''):
    global skipped
    print(f"  ○ SKIP {name} {detail}")
    skipped += 1

# pq_nseg 算法：与节点 GaussDBVectorStore.calcPqNseg 完全一致
def calc_pq_nseg(dim):
    if dim <= 512:
        return dim
    if dim <= 1024:
        return dim // 2
    for c in [96, 128, 192, 256, 384]:
        if dim % c == 0:
            return c
    # fallback: [8, dim/4] 最大因子，保证整除 dim
    target = dim // 4
    for c in range(target, 7, -1):
        if dim % c == 0:
            return c
    return dim  # 质数 dim: pq_nseg = dim 必整除

def vec_literal(dim, val=0.1):
    return '[' + ','.join([str(val)] * dim) + ']'

print(f"\n=== L4: GaussDB 向量能力测试（SQL 契约层）===")
print(f"目标: {HOST}:{PORT}/{DATABASE} (user={USER})\n")

# 选组
group_only = None
if '--group' in sys.argv:
    group_only = int(sys.argv[sys.argv.index('--group') + 1])

# 连接
try:
    conn = psycopg2.connect(host=HOST, port=PORT, user=USER, password=PASSWORD, database=DATABASE)
    conn.autocommit = True
    cur = conn.cursor()
except Exception as e:
    print(f"✗ 连接失败: {e}")
    sys.exit(1)

# 探测拓扑：datcompatibility A=集中式 / ORA=分布式
try:
    cur.execute("SELECT datcompatibility FROM pg_database WHERE datname = current_database()")
    compat = cur.fetchone()[0]
    is_centralized = (compat == 'A')
    print(f"形态: datcompatibility={compat} → {'集中式(测到4096维)' if is_centralized else '分布式(>1024维跳过)'}")
except Exception as e:
    print(f"✗ 形态探测失败: {e}")
    sys.exit(1)

# 会话级调大 maintenance_work_mem（建向量索引需要，GaussDB SET 带引号）
try:
    cur.execute("SET maintenance_work_mem = '512MB'")
    print("会话: maintenance_work_mem='512MB'\n")
except Exception as e:
    print(f"⚠ SET maintenance_work_mem 失败（建索引可能报内存不足）: {e}\n")


def group_crud():
    """组1：向量 CRUD"""
    print("--- 组1: 向量 CRUD（floatvector + GsIVFFLAT + <+> 检索）---")
    TBL = 'n8n_l4_vec_crud'
    cur.execute(f'DROP TABLE IF EXISTS {TBL}')
    try:
        cur.execute(f'CREATE TABLE {TBL} (id int PRIMARY KEY, text text, embedding floatvector(3) NOT NULL)')
        check('建表 floatvector(3)', True)
    except Exception as e:
        check('建表 floatvector(3)', False, str(e)[:80]); return

    try:
        cur.execute(f"INSERT INTO {TBL} VALUES (1,'hello','[0.1,0.2,0.3]'), (2,'world','[0.4,0.5,0.6]'), (3,'foo','[0.9,0.0,0.1]')")
        check('INSERT 字符串字面量', True)
    except Exception as e:
        check('INSERT 字符串字面量', False, str(e)[:80]); return

    try:
        cur.execute(f'CREATE INDEX ON {TBL} USING gsivfflat (embedding cosine) WITH (ivf_nlist = 10)')
        check('GsIVFFLAT 索引', True)
    except Exception as e:
        check('GsIVFFLAT 索引', False, str(e)[:80])

    try:
        cur.execute(f"SELECT id, embedding <+> '[0.1,0.2,0.3]' AS distance FROM {TBL} ORDER BY distance LIMIT 2")
        rows = cur.fetchall()
        scored = [(r[0], 1 - float(r[1])) for r in rows]
        check('<+> 检索 + score=1-dist', len(scored) == 2, f'top2={scored}')
        # 自检索 id=1 应 score≈1.0
        hit = next((s for s in scored if s[0] == 1), None)
        check('score 公式（id=1 自检索≈1.0）', hit is not None and abs(hit[1] - 1.0) < 0.001, f'score={hit[1] if hit else None}')
    except Exception as e:
        check('<+> 检索', False, str(e)[:80])

    try:
        cur.execute(f"UPDATE {TBL} SET embedding = '[0.2,0.2,0.2]' WHERE id = 2")
        check('UPDATE 向量', True)
    except Exception as e:
        check('UPDATE 向量', False, str(e)[:80])

    try:
        cur.execute(f"DELETE FROM {TBL} WHERE id = 3")
        cur.execute(f"SELECT count(*) FROM {TBL}")
        cnt = cur.fetchone()[0]
        check('DELETE 向量', cnt == 2, f'count={cnt}')
    except Exception as e:
        check('DELETE 向量', False, str(e)[:80])

    cur.execute(f'DROP TABLE IF EXISTS {TBL}')


def try_dim(method, dim, idx_sql, expect_ok=True):
    """组2 辅助：单维度建表+索引。expect_ok=True 应成功；False 应被拒（硬限验证）"""
    tbl = f'n8n_l4_dim_{method}_{dim}'
    cur.execute(f'DROP TABLE IF EXISTS {tbl}')
    try:
        cur.execute(f'CREATE TABLE {tbl} (id int, embedding floatvector({dim}) NOT NULL)')
        cur.execute(f"INSERT INTO {tbl} VALUES (1, %s::floatvector)", (vec_literal(dim),))
        cur.execute(idx_sql.format(tbl=tbl))
        cur.execute(f'DROP TABLE IF EXISTS {tbl}')
        if expect_ok:
            check(f'{method} dim={dim}', True)
        else:
            check(f'{method} dim={dim} 应被拒(硬限)', False, '意外成功')
    except Exception as e:
        cur.execute(f'DROP TABLE IF EXISTS {tbl}')
        if expect_ok:
            check(f'{method} dim={dim}', False, str(e)[:90])
        else:
            check(f'{method} dim={dim} 被拒(硬限生效)', True)


def group_dim():
    """组2：维度上限—— 无PQ 索引 ≤1024 可用，>1024 硬限被拒"""
    print("\n--- 组2: 维度上限（GsIVFFLAT / GsDiskANN 无PQ：≤1024 可用 + >1024 硬限）---")
    # ≤1024 无PQ 索引应成功
    try_dim('ivfflat', 1024, 'CREATE INDEX ON {tbl} USING gsivfflat (embedding cosine) WITH (ivf_nlist=10)')
    try_dim('diskann_nopq', 1024, 'CREATE INDEX ON {tbl} USING gsdiskann (embedding cosine)')
    # >1024 无PQ 应被拒（物理硬限；>1024 必须用 PQ，见组3）
    if is_centralized:
        try_dim('ivfflat', 1536, 'CREATE INDEX ON {tbl} USING gsivfflat (embedding cosine) WITH (ivf_nlist=10)', expect_ok=False)
        try_dim('diskann_nopq', 1536, 'CREATE INDEX ON {tbl} USING gsdiskann (embedding cosine)', expect_ok=False)
    else:
        skip('无PQ >1024 硬限验证', '分布式本身≤1024')


def group_pq():
    """组3：GsDiskANN+PQ 高维"""
    print("\n--- 组3: GsDiskANN+PQ 高维（1536/3072/4096 + pq_nseg 整除）---")
    for dim in [1536, 3072, 4096]:
        if not is_centralized and dim > 1024:
            skip(f'GsDiskANN+PQ dim={dim}', '分布式>1024')
            continue
        tbl = f'n8n_l4_pq_{dim}'
        nseg = calc_pq_nseg(dim)
        cur.execute(f'DROP TABLE IF EXISTS {tbl}')
        try:
            cur.execute(f'CREATE TABLE {tbl} (id int, embedding floatvector({dim}) NOT NULL)')
            cur.execute(f"INSERT INTO {tbl} VALUES (1, %s::floatvector)", (vec_literal(dim),))
            cur.execute(
                f'CREATE INDEX ON {tbl} USING gsdiskann (embedding cosine) '
                f'WITH (pq_nseg={nseg}, pq_nclus=16, enable_pq=true, subgraph_count=1, enable_vector_copy=false)'
            )
            check(f'PQ 索引 dim={dim} pq_nseg={nseg}', dim % nseg == 0, f'整除={dim % nseg == 0}')
            cur.execute(f"SELECT id, embedding <+> %s::floatvector AS dist FROM {tbl} ORDER BY dist LIMIT 1", (vec_literal(dim),))
            dist = cur.fetchone()[1]
            check(f'PQ 检索 dim={dim}', dist is not None, f'dist={dist}')
        except Exception as e:
            check(f'PQ dim={dim} pq_nseg={nseg}', False, str(e)[:100])
        cur.execute(f'DROP TABLE IF EXISTS {tbl}')


def group_boundary():
    """组4：向量边界"""
    print("\n--- 组4: 向量边界（空结果 / 超大 top-k / 零向量）---")
    TBL = 'n8n_l4_bvec'
    cur.execute(f'DROP TABLE IF EXISTS {TBL}')
    try:
        cur.execute(f'CREATE TABLE {TBL} (id int PRIMARY KEY, content text, embedding floatvector(3) NOT NULL, metadata jsonb)')
        cur.execute(f"INSERT INTO {TBL} VALUES (1,'doc1','[0.1,0.2,0.3]','{{\"k\":\"a\"}}'), (2,'doc2','[0.4,0.5,0.6]','{{\"k\":\"b\"}}')")
        check('建表 + 插入 2 向量', True)
    except Exception as e:
        check('建表 + 插入', False, str(e)[:80]); cur.execute(f'DROP TABLE IF EXISTS {TBL}'); return

    # 超大 top-k（超过实际行数）
    try:
        cur.execute(f"SELECT id FROM {TBL} ORDER BY embedding <+> '[0.1,0.2,0.3]' LIMIT 1000")
        rows = cur.fetchall()
        check('超大 top-k=1000', len(rows) == 2, f'实际返回={len(rows)}')
    except Exception as e:
        check('超大 top-k', False, str(e)[:80])

    # 零向量检索（不报错）
    try:
        cur.execute(f"SELECT id FROM {TBL} ORDER BY embedding <+> '[0,0,0]' LIMIT 2")
        rows = cur.fetchall()
        check('零向量检索', len(rows) == 2, f'返回={len(rows)}')
    except Exception as e:
        check('零向量检索', False, str(e)[:80])

    # metadata 过滤不匹配（空结果）
    try:
        cur.execute(f"SELECT id FROM {TBL} WHERE metadata->>'k' = 'nonexistent' ORDER BY embedding <+> '[0.1,0.2,0.3]' LIMIT 5")
        rows = cur.fetchall()
        check('不匹配 filter 空结果', len(rows) == 0, f'返回={len(rows)}')
    except Exception as e:
        check('不匹配 filter', False, str(e)[:80])

    cur.execute(f'DROP TABLE IF EXISTS {TBL}')


# 执行
if group_only is None or group_only == 1:
    group_crud()
if group_only is None or group_only == 2:
    group_dim()
if group_only is None or group_only == 3:
    group_pq()
if group_only is None or group_only == 4:
    group_boundary()

cur.close()
conn.close()

print(f"\n=== 结果: {passed} 通过, {failed} 失败, {skipped} 跳过 ===")
sys.exit(0 if failed == 0 else 1)
