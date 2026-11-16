#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -x runtime/python/bin/python3 ]; then
  runtime/python/bin/python3 platform/setup_models.py "$@"
else
  python3 platform/setup_models.py "$@"
fi
printf '\nPress Enter to close...'
read -r answer