#!/bin/bash
set -euo pipefail

# Atoo Studio — Proxmox LXC Helper Script
#
# Creates an LXC container on Proxmox VE with all dependencies pre-installed.
#
# Usage (on Proxmox host):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/main/proxmox/lxc.sh)"
#
# Or download and run:
#   curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/main/proxmox/lxc.sh -o lxc.sh
#   bash lxc.sh

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; }
die()   { error "$@"; exit 1; }

# ── Check we're on Proxmox ──
command -v pct &>/dev/null || die "pct not found. This script must be run on a Proxmox VE host."
[ "$(id -u)" -eq 0 ] || die "This script must be run as root."

# ── Header ──
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       Atoo Studio — Proxmox LXC          ║${NC}"
echo -e "${BOLD}║    Agentic Development Environment        ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Defaults ──
DEFAULT_CTID=$(pvesh get /cluster/nextid 2>/dev/null || echo 100)
DEFAULT_HOSTNAME="atoo-studio"
DEFAULT_STORAGE="local-lvm"
DEFAULT_DISK=20
DEFAULT_CORES=2
DEFAULT_RAM=2048
DEFAULT_BRIDGE="vmbr0"
DEFAULT_PRIVILEGED="no"

# ── Interactive prompts ──
prompt() {
  local var="$1" prompt_text="$2" default="$3"
  read -rp "$(echo -e "${CYAN}?${NC} ${prompt_text} [${BOLD}${default}${NC}]: ")" value
  eval "$var=\"${value:-$default}\""
}

prompt CTID        "Container ID"     "$DEFAULT_CTID"
prompt CT_HOSTNAME "Hostname"         "$DEFAULT_HOSTNAME"
prompt STORAGE     "Storage"          "$DEFAULT_STORAGE"
prompt DISK_SIZE   "Disk size (GB)"   "$DEFAULT_DISK"
prompt CORES       "CPU cores"        "$DEFAULT_CORES"
prompt RAM         "RAM (MB)"         "$DEFAULT_RAM"
prompt BRIDGE      "Network bridge"   "$DEFAULT_BRIDGE"

echo ""
echo -e "${YELLOW}Serial device support (CUSE) requires a privileged container.${NC}"
echo -e "${YELLOW}Only enable this if you need DTR/RTS control signals for flashing devices (e.g. ESP32).${NC}"
prompt PRIVILEGED  "Privileged container (yes/no)" "$DEFAULT_PRIVILEGED"

UNPRIVILEGED=1
CUSE_OPTS=""
if [[ "$PRIVILEGED" =~ ^[Yy] ]]; then
  UNPRIVILEGED=0
  warn "Creating privileged container (less secure, but required for CUSE)."
fi

# ── Download Debian 12 template ──
TEMPLATE="debian-12-standard_12.7-1_amd64.tar.zst"
TEMPLATE_PATH="/var/lib/vz/template/cache/$TEMPLATE"

if [ ! -f "$TEMPLATE_PATH" ]; then
  info "Downloading Debian 12 template..."
  pveam update >/dev/null 2>&1 || true
  # Find the latest Debian 12 template
  AVAILABLE=$(pveam available --section system 2>/dev/null | grep "debian-12-standard" | tail -1 | awk '{print $2}')
  if [ -z "$AVAILABLE" ]; then
    die "Could not find Debian 12 template. Run 'pveam update' and try again."
  fi
  pveam download local "$AVAILABLE"
  TEMPLATE="$AVAILABLE"
  TEMPLATE_PATH="/var/lib/vz/template/cache/$TEMPLATE"
fi

ok "Template: $TEMPLATE"

# ── Create container ──
echo ""
info "Creating LXC container $CTID..."

pct create "$CTID" "local:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --rootfs "$STORAGE:$DISK_SIZE" \
  --cores "$CORES" \
  --memory "$RAM" \
  --swap 512 \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged "$UNPRIVILEGED" \
  --onboot 1 \
  --features nesting=1 \
  --start 0

ok "Container $CTID created."

# ── CUSE passthrough for privileged containers ──
if [ "$UNPRIVILEGED" -eq 0 ]; then
  if [ -e /dev/cuse ]; then
    info "Configuring CUSE passthrough..."
    # Allow all devices and mount /dev/cuse
    cat >> "/etc/pve/lxc/${CTID}.conf" <<EOF

# Atoo Studio: CUSE passthrough for serial control signals
lxc.cgroup2.devices.allow: a
lxc.mount.entry: /dev/cuse dev/cuse none bind,create=file 0 0
EOF
    ok "CUSE passthrough configured."
  else
    warn "/dev/cuse not found on host. Load the cuse kernel module first:"
    warn "  modprobe cuse && echo cuse > /etc/modules-load.d/cuse.conf"
  fi
fi

# ── Start container ──
info "Starting container..."
pct start "$CTID"

# Wait for network
info "Waiting for network..."
for i in $(seq 1 30); do
  if pct exec "$CTID" -- ping -c1 -W1 8.8.8.8 &>/dev/null; then
    break
  fi
  sleep 1
done

# ── Install dependencies inside the container ──
info "Installing system dependencies (this may take a few minutes)..."

pct exec "$CTID" -- bash -c '
set -e

export DEBIAN_FRONTEND=noninteractive

# System packages
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  curl wget gnupg ca-certificates \
  git ffmpeg procps \
  gcc make pkg-config \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libatspi2.0-0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libcairo2 libpango-1.0-0 \
  $(apt-cache show libasound2t64 >/dev/null 2>&1 && echo libasound2t64 || echo libasound2) \
  >/dev/null 2>&1

# Node.js 20
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
fi

# GitHub CLI
if ! command -v gh &>/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq gh >/dev/null 2>&1
fi

# Install Atoo Studio
npm install -g atoo-studio 2>&1 | tail -1

# Create systemd service
cat > /etc/systemd/system/atoo-studio.service <<SVCEOF
[Unit]
Description=Atoo Studio - Agentic Development Environment
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/npx atoo-studio
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable --now atoo-studio.service

apt-get clean
rm -rf /var/lib/apt/lists/*
'

ok "Dependencies installed."

# ── Get container IP ──
CT_IP=""
for i in $(seq 1 15); do
  CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$CT_IP" ] && break
  sleep 1
done

# ── Done ──
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Atoo Studio is ready!             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Container ID:  ${BOLD}$CTID${NC}"
echo -e "  Hostname:      ${BOLD}$CT_HOSTNAME${NC}"
echo -e "  Resources:     ${BOLD}${CORES} cores, ${RAM}MB RAM, ${DISK_SIZE}GB disk${NC}"
if [ -n "$CT_IP" ]; then
  echo -e "  Access:        ${BOLD}https://${CT_IP}:3010${NC}"
fi
if [ "$UNPRIVILEGED" -eq 0 ]; then
  echo -e "  CUSE:          ${BOLD}Enabled (privileged)${NC}"
fi
echo ""
echo -e "  Manage:        ${CYAN}pct enter $CTID${NC}"
echo -e "  Logs:          ${CYAN}pct exec $CTID -- journalctl -u atoo-studio -f${NC}"
echo ""
