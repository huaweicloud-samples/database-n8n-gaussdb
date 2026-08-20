#!/usr/bin/env python3
"""
L2 测试：GaussDB 连通性 + 节点加载验证
从 .env.test 读配置，无需手改。
依赖：pip install psycopg2-binary
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

def check(name, condition, detail=''):
    global passed, failed
    if condition:
        print(f"✓ {name} {detail}")
        passed += 1
    else:
        print(f"✗ {name} {detail}")
        failed += 1

print(f"\n=== L2: GaussDB 连通性测试 ===")
print(f"目标: {HOST}:{PORT}/{DATABASE} (user={USER})\n")

# 1. 连接
try:
    conn = psycopg2.connect(host=HOST, port=PORT, user=USER, password=PASSWORD, database=DATABASE)
    cur = conn.cursor()
    check("pg-promise/psycopg2 连通", True)
except Exception as e:
    check("连通", False, str(e)[:100])
    sys.exit(1)

# 2. 版本
try:
    cur.execute("SELECT version()")
    ver = cur.fetchone()[0]
    check("GaussDB 版本", "GaussDB Kernel 507" in ver, ver[:60])
except Exception as e:
    check("版本", False, str(e)[:100])

# 3. 兼容模式
try:
    cur.execute("SELECT datcompatibility FROM pg_database WHERE datname = current_database()")
    compat = cur.fetchone()[0]
    check("O模式 (datcompatibility=A)", compat == 'A', f"datcompatibility={compat}")
except Exception as e:
    check("兼容模式", False, str(e)[:100])

# 4. enable_vectordb
try:
    cur.execute("SHOW enable_vectordb")
    vdb = cur.fetchone()[0]
    check("enable_vectordb=on", vdb == 'on', f"enable_vectordb={vdb}")
except Exception as e:
    check("enable_vectordb", False, str(e)[:100])

# 5. maintenance_work_mem
try:
    cur.execute("SHOW maintenance_work_mem")
    mwm = cur.fetchone()[0]
    check("maintenance_work_mem", True, f"={mwm} (节点会话级 SET 512MB)")
except Exception as e:
    check("maintenance_work_mem", False, str(e)[:100])

# 6. 向量类型可用
try:
    cur.execute("DROP TABLE IF EXISTS n8n_test_conn_probe")
    cur.execute("CREATE TABLE n8n_test_conn_probe (id int, v floatvector(3) NOT NULL)")
    cur.execute("DROP TABLE n8n_test_conn_probe")
    conn.commit()
    check("floatvector 类型可用", True)
except Exception as e:
    check("floatvector 类型", False, str(e)[:100])
    conn.rollback()

cur.close()
conn.close()

print(f"\n=== 结果: {passed} 通过, {failed} 失败 ===")
sys.exit(0 if failed == 0 else 1)
