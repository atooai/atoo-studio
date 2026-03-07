#!/bin/bash
set -e

# Setup CUSE (Character device in Userspace) for virtual serial port support.
# This enables DTR/RTS control signal forwarding for tools like esptool.py.
#
# Must be run as root. Only needed once per system.
#
# Requirements:
#   - Linux VM or bare-metal (NOT a container — see below)
#   - Root access
#   - gcc, pkg-config
#
# Container note (LXC/Docker):
#   CUSE requires kernel module loading and /dev device creation, which
#   containers cannot do. If running inside a container:
#     1. On the HOST: modprobe cuse && chmod 0666 /dev/cuse
#     2. Pass /dev/cuse into the container:
#        - LXC:    lxc.mount.entry: /dev/cuse dev/cuse none bind,create=file 0 0
#        - Docker: docker run --device /dev/cuse ...
#     3. LXC must be PRIVILEGED (unprivileged containers cannot create device nodes)
#     4. Then run this script inside the container (skip modprobe step)
#
#   If you're on an unprivileged LXC container, CUSE won't work.
#   Use a VM instead, or rely on the PTY fallback (BOOT button for flashing).

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root (sudo $0)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/src/serial/native"
BUILD_DIR="$NATIVE_DIR/build/Release"

echo "=== Setting up CUSE for ccproxy ==="

# Detect container environment
VIRT=""
if command -v systemd-detect-virt &>/dev/null; then
  VIRT="$(systemd-detect-virt -c 2>/dev/null || true)"
elif [ -f /proc/1/cgroup ]; then
  if grep -qE 'lxc|docker|containerd' /proc/1/environ 2>/dev/null || \
     grep -qE '/lxc/|/docker/' /proc/1/cgroup 2>/dev/null; then
    VIRT="container"
  fi
fi
# Also check for /.dockerenv
if [ -f /.dockerenv ]; then
  VIRT="docker"
fi

IS_CONTAINER=false
case "$VIRT" in
  lxc|lxc-libvirt|docker|podman|container)
    IS_CONTAINER=true
    ;;
esac

if [ "$IS_CONTAINER" = true ]; then
  echo ""
  echo "  Container detected: $VIRT"
  echo ""
  echo "  CUSE requires kernel-level access that containers don't have."
  echo "  You need to set this up on the HOST first:"
  echo ""
  echo "    1. On the host, load the cuse kernel module:"
  echo "       sudo modprobe cuse"
  echo "       echo cuse | sudo tee /etc/modules-load.d/cuse.conf"
  echo ""
  echo "    2. On the host, make /dev/cuse accessible:"
  echo "       sudo chmod 0666 /dev/cuse"
  echo "       # To persist across reboots, add a udev rule on the host:"
  echo "       echo 'KERNEL==\"cuse\", MODE=\"0666\"' | sudo tee /etc/udev/rules.d/99-cuse.rules"
  echo "       sudo udevadm control --reload-rules"
  echo ""
  if [ "$VIRT" = "lxc" ] || [ "$VIRT" = "lxc-libvirt" ]; then
    echo "    3. Pass /dev/cuse into this LXC container and allow device creation."
    echo "       Add to the container config (e.g. /etc/pve/lxc/<ID>.conf):"
    echo ""
    echo "       lxc.cgroup2.devices.allow: a"
    echo "       lxc.mount.entry: /dev/cuse dev/cuse none bind,create=file 0 0"
    echo ""
    echo "       Important: The LXC container MUST be privileged (unprivileged: 0)."
    echo "       CUSE creates device nodes in /dev which unprivileged containers"
    echo "       cannot do. Switching an existing container from unprivileged to"
    echo "       privileged can break file ownership — it's easier to create a"
    echo "       new privileged container if needed."
    echo ""
    echo "       'devices.allow: a' is also required because CUSE creates device"
    echo "       nodes (/dev/ttyVS*) with dynamically assigned major/minor numbers."
    echo "       On a VM or bare-metal, none of this is needed."
    echo ""
    echo "    4. Restart the container, then re-run this script."
  elif [ "$VIRT" = "docker" ] || [ "$VIRT" = "podman" ]; then
    echo "    3. Run the container with --device /dev/cuse"
    echo "       docker run --device /dev/cuse ..."
    echo ""
    echo "    4. Re-run this script inside the container."
  else
    echo "    3. Pass /dev/cuse into this container and re-run this script."
  fi
  echo ""

  # Check if /dev/cuse was already passed through
  if [ -e /dev/cuse ]; then
    echo "  /dev/cuse is available — host setup appears done. Continuing..."
    echo ""

    # Verify /dev/cuse is actually accessible
    if [ ! -w /dev/cuse ]; then
      echo "  Error: /dev/cuse exists but is not writable."
      echo "  On the HOST, run: sudo chmod 0666 /dev/cuse"
      echo "  Or add a udev rule (see instructions above)."
      exit 1
    fi
  else
    echo "  /dev/cuse is NOT available. Complete the host setup above first."
    echo ""
    echo "  Note: Without CUSE, ccproxy will still work using PTY fallback,"
    echo "  but DTR/RTS control signals won't be forwarded. You'll need to"
    echo "  use the BOOT button on your device when flashing."
    exit 1
  fi
fi

# 1. Install libfuse3-dev if needed
if ! pkg-config --exists fuse3 2>/dev/null; then
  echo "Installing libfuse3-dev..."
  if command -v apt-get &>/dev/null; then
    apt-get install -y libfuse3-dev || true
    # Verify it actually installed despite possible unrelated dpkg errors
    if ! pkg-config --exists fuse3 2>/dev/null; then
      echo "Error: libfuse3-dev failed to install."
      exit 1
    fi
  elif command -v dnf &>/dev/null; then
    dnf install -y fuse3-devel
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm fuse3
  else
    echo "Error: Could not install libfuse3-dev. Install it manually."
    exit 1
  fi
fi

# 2. Load cuse kernel module (skip in containers — must be done on host)
if [ "$IS_CONTAINER" = true ]; then
  if [ ! -e /dev/cuse ]; then
    echo "Error: /dev/cuse not available. Load cuse module on the host first."
    exit 1
  fi
  echo "Container mode: skipping modprobe (using host-provided /dev/cuse)"
else
  if ! lsmod | grep -q '^cuse '; then
    echo "Loading cuse kernel module..."
    if ! modprobe cuse 2>/dev/null; then
      echo ""
      echo "Error: Failed to load cuse kernel module."
      echo ""
      echo "Possible causes:"
      echo "  - Module not available in your kernel ($(uname -r))"
      echo "    Try: apt-get install linux-modules-extra-$(uname -r)"
      echo "    Or rebuild kernel with CONFIG_CUSE=m"
      echo "  - Running inside a container (modprobe is restricted)"
      echo ""
      echo "Without CUSE, ccproxy will use PTY fallback (no DTR/RTS signals)."
      echo "You'll need to use the BOOT button on your device when flashing."
      exit 1
    fi
  fi

  # Persist across reboots
  if [ -d /etc/modules-load.d ]; then
    echo "cuse" > /etc/modules-load.d/ccproxy-cuse.conf
    echo "Persisted cuse module load to /etc/modules-load.d/ccproxy-cuse.conf"
  fi
fi

# 3. Build the CUSE serial helper
echo "Building cuse_serial..."
mkdir -p "$BUILD_DIR"
gcc -Wall -Wextra -O2 \
  "$NATIVE_DIR/cuse_serial.c" \
  -o "$BUILD_DIR/cuse_serial" \
  $(pkg-config --cflags --libs fuse3) \
  -lpthread

echo "Built: $BUILD_DIR/cuse_serial"

# 4. Set capability so it can create /dev/ entries without full root
echo "Setting CAP_SYS_ADMIN capability on cuse_serial..."
if setcap cap_sys_admin+ep "$BUILD_DIR/cuse_serial" 2>/dev/null; then
  echo "Capability set. cuse_serial can run without root."
else
  echo ""
  echo "  Warning: setcap failed (common in LXC/Docker containers)."
  echo "  The cuse_serial binary will need to run as root."
  echo ""
  echo "  To allow non-root usage, set the suid bit instead:"
  echo "    sudo chown root:root $BUILD_DIR/cuse_serial"
  echo "    sudo chmod u+s $BUILD_DIR/cuse_serial"
  echo ""
  echo "  Or run ccproxy itself as root (not recommended)."
  echo ""

  # In container mode, set suid as fallback since setcap doesn't work
  if [ "$IS_CONTAINER" = true ]; then
    echo "  Applying suid fallback for container environment..."
    chown root:root "$BUILD_DIR/cuse_serial"
    chmod u+s "$BUILD_DIR/cuse_serial"
    echo "  Done: suid bit set on cuse_serial."
  fi
fi

# 5. Add udev rule so the created /dev/ttyVS* devices are world-accessible
if command -v udevadm &>/dev/null; then
  UDEV_RULE="/etc/udev/rules.d/99-ccproxy-serial.rules"
  echo 'KERNEL=="ttyVS[0-9]*", MODE="0666"' > "$UDEV_RULE"
  udevadm control --reload-rules 2>/dev/null || true
  echo "Installed udev rule: $UDEV_RULE"
else
  echo "Warning: udevadm not found. /dev/ttyVS* devices may need manual chmod."
fi

echo ""
echo "=== CUSE setup complete ==="
echo "Virtual serial devices (/dev/ttyVS*) will now support DTR/RTS control signals."
echo "No reboot required."
