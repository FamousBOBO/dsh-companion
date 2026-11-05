#!/usr/bin/env python3
"""本机 embed 服务：OpenAI 兼容的 `POST /v1/embeddings`（P6e·e2）。

为什么自己起一个：模型网关（cline-pass / windhub）都不提供 embeddings 接口，
而记忆检索要向量。这个服务只监听 127.0.0.1，模型用 `BAAI/bge-small-zh-v1.5`
（512 维，中文小模型，约 100MB）。

契约（与 `src/adapters/providers/embed.ts` 对齐）：
  - 请求：`{"model": "<任意>", "input": "文本" | ["a","b",...]}`
  - 响应：`{"data": [{"index": 0, "embedding": [...]}, ...], "model": ..., "usage": {...}}`
  - 维度固定 512；拿不到模型就直接 503（调用方会退回关键词路径，不会写坏索引）。

用法：
    python3 server.py [--port 8801] [--model BAAI/bge-small-zh-v1.5]
"""

import argparse
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIM_BY_MODEL = {
    'BAAI/bge-small-zh-v1.5': 512,
    'BAAI/bge-small-en-v1.5': 384,
    'BAAI/bge-small-en': 384,
}

_lock = threading.Lock()
_embedder = None
_model_name = None
# 本地模型目录（离线部署：HF 被墙时用 ModelScope 拉下来的 Qdrant onnx 包）。
_model_path = None


def load_embedder(name: str):
    global _embedder, _model_name
    with _lock:
        if _embedder is None:
            from fastembed import TextEmbedding
            _embedder = TextEmbedding(
                model_name=name,
                **({'specific_model_path': _model_path} if _model_path else {}),
            )
            _model_name = name
            print(f'[embed] 模型已加载：{name}（{DIM_BY_MODEL.get(name, "?")} 维）', flush=True)
        return _embedder


def clean_text(value: str) -> str:
    """去掉孤立代理项与控制字符。

    JSON 里可能出现 `\\ud83d` 这种半个 emoji（日志截断、拼接产生），Python 的 str
    能装下它，但 tokenizer 会抛 `TextEncodeInput must be Union[...]`——一整批向量
    因此失败。这里按 UTF-8 可编码性过滤，坏字符丢掉而不是让整条链路挂掉。
    """
    return value.encode('utf-8', 'ignore').decode('utf-8', 'ignore').strip()


def embed_texts(texts):
    embedder = load_embedder(_model_name)
    vectors = []
    for vec in embedder.embed(texts):
        # fastembed 返回 numpy 数组；转成普通 float 列表
        vectors.append([float(x) for x in vec])
    return vectors


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # 少刷日志：每请求一行太多，只留错误
        if str(args[1] if len(args) > 1 else '') >= '400':
            sys.stderr.write('[embed] ' + (fmt % args) + '\n')

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip('/') in ('/health', '/healthz'):
            self._send(200, {'ok': _embedder is not None, 'model': _model_name})
            return
        self._send(404, {'error': {'message': 'not found'}})

    def do_POST(self):
        if not self.path.rstrip('/').endswith('/embeddings'):
            self._send(404, {'error': {'message': 'not found'}})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            payload = json.loads(self.rfile.read(length) or b'{}')
            raw = payload.get('input')
            texts = [raw] if isinstance(raw, str) else list(raw or [])
            if not texts or any(not isinstance(t, str) for t in texts):
                self._send(400, {'error': {'message': 'input 必须是字符串或字符串数组'}})
                return
            texts = [clean_text(t) for t in texts]
            if any(t == '' for t in texts):
                self._send(400, {'error': {'message': 'input 里有空字符串（清洗后为空）'}})
                return
            if _embedder is None:
                load_embedder(_model_name)
            vectors = embed_texts(texts)
            dim = DIM_BY_MODEL.get(_model_name, len(vectors[0]) if vectors else 0)
            for i, vec in enumerate(vectors):
                if len(vec) != dim:
                    self._send(500, {'error': {'message': f'维度异常：第 {i} 条是 {len(vec)}，期望 {dim}'}})
                    return
            self._send(200, {
                'model': _model_name,
                'data': [{'index': i, 'object': 'embedding', 'embedding': vec} for i, vec in enumerate(vectors)],
                'usage': {'prompt_tokens': sum(len(t) for t in texts), 'total_tokens': sum(len(t) for t in texts)},
            })
        except Exception as exc:  # noqa: BLE001 —— 任何失败都回 503，让调用方退回关键词
            self._send(503, {'error': {'message': f'embed 服务不可用：{exc}'}})


def main():
    global _model_name, _model_path
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8801)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--model', default='BAAI/bge-small-zh-v1.5')
    # 离线模型目录；不给就用 fastembed 自己的下载/缓存逻辑。
    parser.add_argument('--model-path', default=os.environ.get('DSH_EMBED_MODEL_PATH') or None)
    args = parser.parse_args()
    _model_name = args.model
    _model_path = args.model_path
    print(f'[embed] 监听 http://{args.host}:{args.port}/v1/embeddings（模型 {args.model}）', flush=True)
    load_embedder(args.model)  # 启动时就加载：第一次请求不该等 30 秒
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
