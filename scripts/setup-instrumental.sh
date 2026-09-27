#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v uv >/dev/null || { printf 'Install uv before running instrumental setup.\n' >&2; exit 1; }
if [ ! -x "$ROOT_DIR/.venv-instrumental/bin/python" ]; then
  uv venv --python 3.11 "$ROOT_DIR/.venv-instrumental"
fi
uv pip install --python "$ROOT_DIR/.venv-instrumental/bin/python" \
  'demucs==4.0.1' 'torch==2.5.1' 'torchaudio==2.5.1' 'numpy<2' 'soundfile==0.13.1'
"$ROOT_DIR/.venv-instrumental/bin/python" -c 'from demucs.pretrained import get_model; get_model("htdemucs")'
printf 'Instrumental processing is ready.\n'
