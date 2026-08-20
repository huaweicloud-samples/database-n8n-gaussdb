#!/usr/bin/env bash
# 一键自动化测试：L2 连通 + L3 数据库节点 + L4 向量
#
# 用法：
#   cp .env.test.example .env.test && vi .env.test
#   ./run_all.sh              # 跑全部
#   ./run_all.sh --skip-l4    # 跳过向量（建索引慢，约 1-3 分钟）
#
# 退出码：0=全过；非0=有失败（适合 CI 判定）
# 依赖：python3 + psycopg2-binary（L2/L4）；gsql 或 psql（L3，可选）
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 检查 .env.test
if [ ! -f .env.test ]; then
  echo "✗ 缺少 .env.test，请先: cp .env.test.example .env.test && vi .env.test"
  exit 2
fi

SKIP_L4=false
[ "${1:-}" = "--skip-l4" ] && SKIP_L4=true

PASS=0; FAIL=0
run() {
  local name="$1"; shift
  echo
  echo "========================================"
  echo "▶ $name"
  echo "========================================"
  if "$@"; then
    echo "■ $name: PASS"
    PASS=$((PASS+1))
  else
    echo "■ $name: FAIL"
    FAIL=$((FAIL+1))
  fi
}

# L2：连通性（python）
if command -v python3 >/dev/null 2>&1; then
  run "L2 GaussDB 连通性" python3 test_gaussdb_connect.py
else
  echo
  echo "○ SKIP L2（无 python3，安装: apk add python3 py3-pip && pip install psycopg2-binary）"
fi

# L3：数据库节点 6 operation SQL 层（需 gsql/psql；无则跳过）
if command -v gsql >/dev/null 2>&1 || command -v psql >/dev/null 2>&1; then
  run "L3 数据库节点 6 operation" bash test_c_operations.sh
else
  echo
  echo "○ SKIP L3（无 gsql/psql，改用 python 或 n8n UI 测）"
fi

# L4：向量（python，建索引较慢）
if [ "$SKIP_L4" = false ]; then
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import psycopg2' 2>/dev/null; then
    run "L4 向量能力" python3 test_vector.py
  else
    echo
    echo "○ SKIP L4（缺 python3 或 psycopg2，安装: pip install psycopg2-binary）"
  fi
else
  echo
  echo "○ SKIP L4（--skip-l4）"
fi

echo
echo "========================================"
echo "总计: $PASS 通过, $FAIL 失败"
echo "========================================"
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
