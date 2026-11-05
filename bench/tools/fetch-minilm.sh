#!/usr/bin/env bash
# Downloads all-MiniLM-L6-v2 in ONNX form (as packaged by Chroma) and checks it, for bench/tools/ollama_compatible.py.
# The archive, model and tokenizer are pinned by SHA-256. Model license: Apache 2.0 (sentence-transformers).
set -euo pipefail
cd "$(dirname "$0")/../.."
dest=bench/.cache/models/all-minilm
mkdir -p "$dest"
archive="$dest/onnx.tar.gz"
if [ ! -f "$archive" ]; then
  curl -fsSL -o "$archive" https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz
fi
echo "913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3  $archive" | sha256sum -c -
tar -xzf "$archive" -C "$dest"
echo "4f148ba8ae9c2c7fbee4af2b132db8d06c6a6545b47fc83bbb98c3d22b8393e6  $dest/onnx/model.onnx" | sha256sum -c -
echo "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0  $dest/onnx/tokenizer.json" | sha256sum -c -
echo "Model ready in $dest/onnx"
