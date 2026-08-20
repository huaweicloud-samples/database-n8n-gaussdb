#!/usr/bin/env bash
# L3 测试（方式二）：SQL 层冒烟
# 直接对 GaussDB 执行 GaussDb 节点会发出的 SQL（O模式适配后），验证 SQL 在目标库可跑。
# 与 n8n UI 端到端（经 n8n 节点 execute）层次互补：
#   本脚本 = SQL 层（运维可直接跑，不依赖 n8n）
#   UI    = 节点层（经 n8n 节点代码 + 真实 UI 参数）
#
# 用法：
#   cp .env.test.example .env.test && vi .env.test
#   ./test_c_operations.sh
#
# 依赖：gsql 或 psql（GaussDB 客户端）
set -uo pipefail

# 加载 .env.test
ENV_FILE="$(dirname "$0")/.env.test"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

HOST="${GAUSSDB_HOST:-localhost}"
PORT="${GAUSSDB_PORT:-5432}"
USER="${GAUSSDB_USER:-appuser}"
DB="${GAUSSDB_DATABASE:-n8n_test}"
export PGPASSWORD="${GAUSSDB_PASSWORD:-}"

# 选客户端：gsql 优先，psql 次之
if command -v gsql >/dev/null 2>&1; then
  CLI=gsql
elif command -v psql >/dev/null 2>&1; then
  CLI=psql
else
  echo "✗ 需要 gsql 或 psql 客户端，或改用 python: python3 test_gaussdb_connect.py"
  exit 1
fi

run_sql() {
  # $1 = SQL；返回结果
  # -q 安静模式：抑制 INSERT 0 1 / UPDATE 1 等状态行（psql 会输出，干扰空输出判断）；SELECT 结果不受影响
  $CLI -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -q -t -A -c "$1" 2>&1
}

passed=0; failed=0
ok()   { echo "✓ $1"; passed=$((passed+1)); }
fail() { echo "✗ $1"; echo "  $2"; failed=$((failed+1)); }

echo "=== L3（方式二）: GaussDb 节点 SQL 层冒烟 ==="
echo "目标: $HOST:$PORT/$DB (user=$USER, client=$CLI)"
echo

TABLE="n8n_l3_smoke"

# 1. executeQuery —— 节点最常用：SELECT version()
v=$(run_sql "SELECT version();")
case "$v" in
  *GaussDB*) ok "executeQuery: SELECT version() → GaussDB 内核" ;;
  *) fail "executeQuery: SELECT version()" "$v" ;;
esac

# 2. insert —— 节点 pgInsert 模式：INSERT INTO ... VALUES
run_sql "DROP TABLE IF EXISTS $TABLE;" >/dev/null 2>&1
run_sql "CREATE TABLE $TABLE (id varchar(36) PRIMARY KEY, name varchar(100), val int);" >/dev/null 2>&1
r=$(run_sql "INSERT INTO $TABLE (id, name, val) VALUES ('l3-001', '测试', 10);")
[ -z "$r" ] && ok "insert: INSERT varchar(36) 主键" || fail "insert" "$r"

# 3. select —— 节点 pgQueryV2 模式
r=$(run_sql "SELECT name, val FROM $TABLE WHERE id = 'l3-001';")
case "$r" in
  *测试*10*) ok "select: SELECT 返回行" ;;
  *) fail "select" "$r" ;;
esac

# 4. update —— 节点 pgUpdate 模式
r=$(run_sql "UPDATE $TABLE SET val = 20 WHERE id = 'l3-001';")
[ -z "$r" ] && ok "update: UPDATE SET" || fail "update" "$r"
r=$(run_sql "SELECT val FROM $TABLE WHERE id = 'l3-001';")
[ "$r" = "20" ] && ok "update: 结果验证 val=20" || fail "update 验证" "$r"

# 5. upsert —— 节点 O模式适配核心：MERGE INTO（不能用 ON CONFLICT）
#    已存在行 → 更新；不存在行 → 插入
r=$(run_sql "MERGE INTO $TABLE t USING (SELECT 'l3-001' AS id) s ON (t.id = s.id)
  WHEN MATCHED THEN UPDATE SET val = 30
  WHEN NOT MATCHED THEN INSERT (id, name, val) VALUES ('l3-001', '测试', 30);")
[ -z "$r" ] && ok "upsert: MERGE INTO（已存在→更新）" || fail "upsert MERGE" "$r"
r=$(run_sql "SELECT val FROM $TABLE WHERE id = 'l3-001';")
[ "$r" = "30" ] && ok "upsert: 已存在行更新为 30" || fail "upsert 验证" "$r"

#    不存在行 → 插入
r=$(run_sql "MERGE INTO $TABLE t USING (SELECT 'l3-002' AS id) s ON (t.id = s.id)
  WHEN NOT MATCHED THEN INSERT (id, name, val) VALUES ('l3-002', '新增', 99);")
[ -z "$r" ] && ok "upsert: MERGE INTO（不存在→插入）" || fail "upsert MERGE 插入" "$r"
r=$(run_sql "SELECT count(*) FROM $TABLE;")
[ "$r" = "2" ] && ok "upsert: 表行数=2" || fail "upsert 行数" "$r"

# 6. deleteTable —— 节点 delete 模式：DELETE / DROP
r=$(run_sql "DELETE FROM $TABLE WHERE id = 'l3-001';")
[ -z "$r" ] && ok "deleteTable: DELETE 行" || fail "delete" "$r"
r=$(run_sql "DROP TABLE $TABLE;")
[ -z "$r" ] && ok "deleteTable: DROP TABLE" || fail "drop" "$r"

echo
echo "=== 结果: $passed 通过, $failed 失败 ==="
exit $([ "$failed" = "0" ] && echo 0 || echo 1)
