#!/usr/bin/env python3
"""
RAG 全流程测试用：本地 OpenAI 兼容 mock server
- POST /v1/embeddings：确定性 1536 维向量（同文本同向量，走 GsDiskANN+PQ 高维路径）
- POST /v1/chat/completions：确定性回答（回显收到的上下文首段）
- GET  /v1/models：模型列表
用法：python3 rag_mock_server.py  （监听 127.0.0.1:3099）
"""
import json
import hashlib
import random
import struct
import base64
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

DIM = 1536
PORT = 3099

def embed_text(text: str):
    """确定性 embedding：文本 hash 作种子生成伪随机向量并归一化。同文本→同向量。"""
    seed = int(hashlib.md5(text.encode('utf-8')).hexdigest(), 16)
    r = random.Random(seed)
    v = [r.uniform(-0.1, 0.1) for _ in range(DIM)]
    norm = sum(x * x for x in v) ** 0.5 or 1.0
    return [round(x / norm, 8) for x in v]

def to_base64(vec):
    """OpenAI encoding_format=base64：float32 little-endian → base64 字符串。
    OpenAI SDK v6 未显式传 encoding_format 时默认请求 base64（性能原因），
    mock 必须模拟该行为，否则 SDK 按 base64 解码 float JSON 会得到全 0 垃圾向量。"""
    return base64.b64encode(struct.pack(f'<{len(vec)}f', *vec)).decode()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write(f"[{self.command} {self.path}] {fmt % args}\n")
        sys.stdout.flush()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/v1/models':
            self._json({"object": "list", "data": [
                {"id": "mock-embedding-1536", "object": "model", "owned_by": "mock"},
                {"id": "mock-chat", "object": "model", "owned_by": "mock"},
            ]})
        elif self.path == '/healthz':
            self._json({"status": "ok"})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except Exception:
            self._json({"error": "bad json"}, 400)
            return

        if self.path == '/v1/embeddings':
            inputs = body.get('input', '')
            if isinstance(inputs, str):
                inputs = [inputs]
            fmt = body.get('encoding_format', 'float')
            data = []
            for i, t in enumerate(inputs):
                vec = embed_text(t)
                emb = to_base64(vec) if fmt == 'base64' else vec
                data.append({"object": "embedding", "index": i, "embedding": emb})
            self._json({
                "object": "list",
                "data": data,
                "model": body.get('model', 'mock-embedding-1536'),
                "usage": {"prompt_tokens": sum(len(str(t)) for t in inputs), "total_tokens": 0},
            })
        elif self.path == '/v1/chat/completions':
            msgs = body.get('messages', [])
            # 找到最长的一条消息内容作为"引用的上下文"回显（确定性）
            content = ''
            if msgs:
                content = max((str(m.get('content', '')) for m in msgs), key=len)[:300]
            self._json({
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "created": 0,
                "model": body.get('model', 'mock-chat'),
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": f"[mock-answer] 依据上下文回答：{content[:150]}"},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            })
        else:
            self._json({"error": "not found"}, 404)

if __name__ == '__main__':
    print(f"mock OpenAI server: http://127.0.0.1:{PORT}  (embeddings {DIM}d + chat)")
    HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
