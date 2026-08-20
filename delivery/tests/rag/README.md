# RAG 全流程验证（无需真实 Embedding API）

本地 OpenAI 兼容 mock 服务 + n8n workflow，验证 **RAG 全链路**：Embeddings API 调用 → GaussDB 向量入库（floatvector + GsDiskANN+PQ 自动建索引）→ `<+>` 相似度检索 → AI Agent 工具链。**不依赖任何真实 embedding API key**。

> 局限说明：mock 向量由文本 hash 确定性生成（同文本同向量），**无语义相似性**——验证的是适配层管道（HTTP 调用/维度/入库/索引/检索/score），不验证语义质量。语义质量由 embedding 模型决定，与 GaussDB 适配无关。

## 资产清单

| 文件 | 用途 |
|---|---|
| `rag_mock_server.py` | OpenAI 兼容 mock 服务（1536 维向量 + chat 端点） |
| `rag_w1_insert.json` | workflow：文档 → Embeddings → GaussDB 入库 |
| `rag_w2_load.json` | workflow：prompt → GaussDB 检索 top-k + score |
| `rag_w6_agent.json` | workflow：AI Agent + GaussDB 向量工具（现代 RAG 形态） |

## 使用步骤

### 1. 起 mock 服务

```bash
python3 rag_mock_server.py
# 监听 http://127.0.0.1:3099，提供 /v1/embeddings + /v1/chat/completions + /v1/models
```

> mock 已处理 OpenAI SDK v6 的 `encoding_format=base64` 默认行为（SDK 未显式传该参数时按 base64 请求并解码，mock 需返回 base64 编码向量，否则 SDK 解析得到全 0 垃圾向量）。

### 2. n8n 配置凭据

1. n8n UI → Credentials → Add → **OpenAI**：API Key 随意（如 `sk-mock-local`），**Base URL 填 `http://127.0.0.1:3099/v1`**
2. Credentials → Add → **Postgres**：填 GaussDB 连接（host/port/database/user/password）

### 3. 导入并执行 workflow

```bash
# 导入（或 UI 里 Import from File）
n8n import:workflow --input=rag_w1_insert.json
n8n import:workflow --input=rag_w2_load.json
n8n import:workflow --input=rag_w6_agent.json
```

导入后每个 workflow 的节点需重新选择凭据（OpenAI / Postgres，JSON 里的凭据 id 是导出环境的），然后 UI 里点 Execute。

### 4. 验证结果

| workflow | 预期 |
|---|---|
| w1 insert | 执行成功；GaussDB 表 `n8n_rag_test` 有 4 行，`embedding` 为 **1536 维**向量；索引为 **GsDiskANN+PQ**（`pq_nseg=96`，>1024 维自动走 PQ 路径） |
| w2 load | 执行成功；返回 top-2 文档 + score（随机向量近正交，score 接近 0 属正常） |
| w6 agent | 执行成功；AI Agent 组装并调用 mock chat 返回回答 |

GaussDB 侧检查：

```sql
-- 维度（应 1536）
SELECT length(embedding::text) - length(replace(embedding::text, ',', '')) + 1 FROM n8n_rag_test LIMIT 1;
-- 索引（应 gsdiskann + pq_nseg=96）
SELECT indexdef FROM pg_indexes WHERE tablename = 'n8n_rag_test' AND indexname LIKE '%embedding%';
```

## 已知问题（非 GaussDB 相关）

"Question and Answer Chain"（`chainRetrievalQa`）节点在 n8n 2.34.6 下执行报 `retrieveDocumentsChain.withConfig is not a function`——n8n 自身依赖问题（In-Memory 向量库同样报错，已对照验证）。RAG 问答请用 AI Agent + 向量工具（w6）。
