#!/bin/zsh

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

BACKEND_VENV_DIR="${BACKEND_VENV_DIR:-/tmp/screen-time-momentum-ai-venv}"
BACKEND_APP_DIR="${BACKEND_APP_DIR:-/tmp/screen-time-momentum-ai-app}"

if [[ ! -f "$BACKEND_VENV_DIR/bin/activate" ]]; then
  rm -rf "$BACKEND_VENV_DIR"
  echo "Creating backend virtualenv at $BACKEND_VENV_DIR ..."
  python3 -m venv "$BACKEND_VENV_DIR"
fi

source "$BACKEND_VENV_DIR/bin/activate"

if [[ ! -f "$BACKEND_VENV_DIR/.installed-screen-time-momentum-ai" ]]; then
  echo "Installing backend dependencies into $BACKEND_VENV_DIR ..."
  pip install -r requirements-ai.txt
  touch "$BACKEND_VENV_DIR/.installed-screen-time-momentum-ai"
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is not set."
  echo 'Run: export OPENAI_API_KEY="your-key-here"'
  exit 1
fi

mkdir -p "$BACKEND_APP_DIR"
cp "$PROJECT_DIR/ai_backend.py" "$BACKEND_APP_DIR/ai_backend.py"

export PYTHONDONTWRITEBYTECODE=1
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-/tmp/screen-time-momentum-ai-pycache}"

cd "$BACKEND_APP_DIR"
python -B -m uvicorn ai_backend:app --host 127.0.0.1 --port 8000
