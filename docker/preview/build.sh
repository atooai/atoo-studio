#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Building ccproxy-preview Docker image ==="

# 1. Bundle container-server.ts with esbuild
echo "Bundling container-server.ts..."
npx esbuild "$SCRIPT_DIR/container-server.ts" \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=esm \
  --outfile="$SCRIPT_DIR/container-server.js" \
  --external:ws

echo "Bundle created: container-server.js"

# 2. Detect container runtime
if [ -n "$CCPROXY_CONTAINER_RUNTIME" ]; then
  RUNTIME="$CCPROXY_CONTAINER_RUNTIME"
elif command -v docker &>/dev/null; then
  RUNTIME=docker
elif command -v podman &>/dev/null; then
  RUNTIME=podman
else
  echo "Error: Neither docker nor podman found."
  exit 1
fi

# 3. Build image
echo "Building image with $RUNTIME..."
$RUNTIME build -t ccproxy-preview:latest "$SCRIPT_DIR"

echo ""
echo "=== Done: ccproxy-preview:latest ==="
echo "Run '$RUNTIME images ccproxy-preview' to verify."
