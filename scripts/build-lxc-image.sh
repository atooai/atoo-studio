#!/bin/bash
set -euo pipefail

# Build an LXC/LXD image from the Atoo Studio Docker image.
#
# Usage: ./build-lxc-image.sh <docker-image> <arch>
#   docker-image: Docker image tag (e.g. ghcr.io/atooai/atoo-studio:latest)
#   arch:         Target architecture (amd64 or arm64)
#
# Output: atoo-studio-lxc-<arch>.tar.gz (unified LXD image)
#
# Import with: lxc image import atoo-studio-lxc-<arch>.tar.gz --alias atoo-studio

DOCKER_IMAGE="${1:?Usage: $0 <docker-image> <arch>}"
ARCH="${2:?Usage: $0 <docker-image> <arch>}"

case "$ARCH" in
  amd64) LXC_ARCH="x86_64"; PLATFORM="linux/amd64" ;;
  arm64) LXC_ARCH="aarch64"; PLATFORM="linux/arm64" ;;
  *) echo "Error: Unsupported architecture: $ARCH (use amd64 or arm64)"; exit 1 ;;
esac

CONTAINER_NAME="atoo-lxc-export-$$"
WORK_DIR=$(mktemp -d)
OUTPUT="atoo-studio-lxc-${ARCH}.tar.gz"

cleanup() {
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== Building LXC image for $ARCH ==="
echo "Source: $DOCKER_IMAGE"
echo ""

# 1. Create a container from the Docker image (don't start it)
echo "Creating container from Docker image..."
docker create --platform "$PLATFORM" --name "$CONTAINER_NAME" "$DOCKER_IMAGE" >/dev/null

# 2. Export the filesystem
echo "Exporting rootfs..."
mkdir -p "$WORK_DIR/rootfs"
docker export "$CONTAINER_NAME" | tar -xf - -C "$WORK_DIR/rootfs"

# 3. Create LXC metadata
echo "Creating metadata..."
cat > "$WORK_DIR/metadata.yaml" <<EOF
architecture: "$LXC_ARCH"
creation_date: $(date +%s)
properties:
  description: "Atoo Studio - Agentic Development Environment"
  os: "debian"
  release: "bookworm"
  variant: "default"
templates:
  /etc/hostname:
    when:
      - create
      - copy
    template: hostname.tpl
EOF

mkdir -p "$WORK_DIR/templates"
cat > "$WORK_DIR/templates/hostname.tpl" <<'EOF'
{{ container.name }}
EOF

# 4. Package as unified LXC/LXD image
# LXD expects: metadata.tar.gz containing metadata.yaml + templates/
#               rootfs.tar.gz containing the filesystem
# Or a single unified tarball with both metadata.yaml and rootfs/ at the top level
echo "Packaging..."

cd "$WORK_DIR"
tar -czf "$OLDPWD/$OUTPUT" metadata.yaml templates/ rootfs/
cd "$OLDPWD"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo ""
echo "=== Done ==="
echo "Output: $OUTPUT ($SIZE)"
echo ""
echo "Import with:"
echo "  lxc image import $OUTPUT --alias atoo-studio"
echo ""
echo "Launch with:"
echo "  lxc launch atoo-studio my-atoo-studio"
