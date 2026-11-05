"""A stand-in for Ollama's /api/embed, for benchmarks on machines where Ollama cannot be installed.

Serves an ONNX sentence-transformer (all-MiniLM-L6-v2, the model Ollama ships as "all-minilm") on 127.0.0.1
only. Request: {"model": ..., "input": str | [str]}. Reply: {"model": ..., "embeddings": [[...]]}.
Mean pooling over the attention mask, then L2 normalisation, as sentence-transformers does. No prefixes: this
model is trained without query or document instructions.

Not identical to Ollama: Ollama runs a GGUF conversion of the same weights, so its vectors can differ slightly,
and results with real Ollama may differ a little. Identical texts are embedded once (an in-memory cache).

    pip install -r bench/tools/requirements.txt
    bash bench/tools/fetch-minilm.sh                      # downloads and checks the model
    python bench/tools/ollama_compatible.py bench/.cache/models/all-minilm/onnx [port] [threads]
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MAX_TOKENS = 256  # sentence-transformers' max_seq_length for all-MiniLM-L6-v2
BATCH = 32

folder = Path(sys.argv[1])
port = int(sys.argv[2]) if len(sys.argv) > 2 else 11434
threads = int(sys.argv[3]) if len(sys.argv) > 3 else 1
tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
tokenizer.enable_truncation(max_length=MAX_TOKENS)
tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
options = ort.SessionOptions()
options.intra_op_num_threads = threads  # 1 by default: one core, like a slow laptop
session = ort.InferenceSession(str(folder / "model.onnx"), options, providers=["CPUExecutionProvider"])
input_names = {i.name for i in session.get_inputs()}


cache = {}


def embed(texts):
    missing = [t for t in dict.fromkeys(texts) if t not in cache]
    for start in range(0, len(missing), BATCH):
        batch = missing[start : start + BATCH]
        for text, vector in zip(batch, embed_batch(batch)):
            cache[text] = vector
    return [cache[t] for t in texts]


def embed_batch(texts):
    out = []
    for start in range(0, len(texts), BATCH):
        encoded = tokenizer.encode_batch(texts[start : start + BATCH])
        ids = np.array([e.ids for e in encoded], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in input_names:
            feed["token_type_ids"] = np.zeros_like(ids)
        hidden = session.run(None, feed)[0]
        summed = (hidden * mask[:, :, None]).sum(axis=1)
        vectors = summed / np.clip(mask.sum(axis=1, keepdims=True), 1, None)
        vectors = vectors / np.clip(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12, None)
        out.extend(vectors.astype(float).tolist())
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != "/api/embed":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        texts = body.get("input", [])
        texts = [texts] if isinstance(texts, str) else texts
        payload = json.dumps({"model": body.get("model", ""), "embeddings": embed(texts)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
