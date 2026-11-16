#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -x runtime/python/bin/python3 ]; then
  exec runtime/python/bin/python3 platform/setup_models.py "$@"
fi
exec python3 platform/setup_models.py "$@"