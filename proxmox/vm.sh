#!/bin/bash
set -euo pipefail

# Atoo Studio — Proxmox VM Helper Script
#
# Creates a VM on Proxmox VE with cloud-init that installs all dependencies.
#
# Usage (on Proxmox host):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/main/proxmox/vm.sh)"
#
# Or download and run:
#   curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/main/proxmox/vm.sh -o vm.sh
#   bash vm.sh

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
command -v qm &>/dev/null || die "qm not found. This script must be run on a Proxmox VE host."
[ "$(id -u)" -eq 0 ] || die "This script must be run as root."

# ── Header ──
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       Atoo Studio — Proxmox VM            ║${NC}"
echo -e "${BOLD}║    Agentic Development Environment        ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Defaults ──
DEFAULT_VMID=$(pvesh get /cluster/nextid 2>/dev/null || echo 200)
DEFAULT_HOSTNAME="atoo-studio"
DEFAULT_STORAGE="local-lvm"
DEFAULT_DISK=50
DEFAULT_CORES=4
DEFAULT_RAM=4096
DEFAULT_BRIDGE="vmbr0"

# ── Interactive prompts ──
prompt() {
  local var="$1" prompt_text="$2" default="$3"
  read -rp "$(echo -e "${CYAN}?${NC} ${prompt_text} [${BOLD}${default}${NC}]: ")" value
  eval "$var=\"${value:-$default}\""
}

prompt VMID        "VM ID"            "$DEFAULT_VMID"
prompt VM_HOSTNAME "Hostname"         "$DEFAULT_HOSTNAME"
prompt STORAGE     "Storage"          "$DEFAULT_STORAGE"
prompt DISK_SIZE   "Disk size (GB)"   "$DEFAULT_DISK"
prompt CORES       "CPU cores"        "$DEFAULT_CORES"
prompt RAM         "RAM (MB)"         "$DEFAULT_RAM"
prompt BRIDGE      "Network bridge"   "$DEFAULT_BRIDGE"

echo ""
echo -e "${CYAN}?${NC} SSH public key (paste, or leave empty to skip):"
read -r SSH_KEY
echo ""

# ── Download Debian 12 cloud image ──
CLOUD_IMG="debian-12-generic-amd64.qcow2"
CLOUD_IMG_PATH="/var/lib/vz/template/iso/$CLOUD_IMG"
CLOUD_IMG_URL="https://cloud.debian.org/images/cloud/bookworm/latest/$CLOUD_IMG"

if [ ! -f "$CLOUD_IMG_PATH" ]; then
  info "Downloading Debian 12 cloud image..."
  mkdir -p /var/lib/vz/template/iso
  wget -q --show-progress -O "$CLOUD_IMG_PATH" "$CLOUD_IMG_URL"
fi

ok "Cloud image: $CLOUD_IMG"

# ── Create cloud-init user-data ──
info "Generating cloud-init configuration..."

SNIPPETS_DIR="/var/lib/vz/snippets"
mkdir -p "$SNIPPETS_DIR"

cat > "$SNIPPETS_DIR/atoo-studio-${VMID}.yaml" <<'CLOUDINIT'
#cloud-config
package_update: true

packages:
  - curl
  - wget
  - gnupg
  - ca-certificates
  - git
  - ffmpeg
  - procps
  - gcc
  - make
  - pkg-config
  - libfuse3-dev
  - libatk1.0-0
  - libatk-bridge2.0-0
  - libcups2
  - libatspi2.0-0
  - libxcomposite1
  - libxdamage1
  - libxfixes3
  - libxrandr2
  - libgbm1
  - libcairo2
  - libpango-1.0-0
  - libasound2

runcmd:
  # Node.js 20
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs

  # GitHub CLI
  - curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  - apt-get update && apt-get install -y gh

  # Install Atoo Studio
  - npm install -g atoo-studio

  # Setup CUSE (VM has full kernel access)
  - modprobe cuse
  - echo cuse > /etc/modules-load.d/cuse.conf
  - chmod 0666 /dev/cuse
  - echo 'KERNEL=="cuse", MODE="0666"' > /etc/udev/rules.d/99-cuse.rules

  # Run setup-cuse.sh from the installed package
  - |
    ATOO_DIR=$(npm root -g)/atoo-studio
    if [ -f "$ATOO_DIR/setup-cuse.sh" ]; then
      bash "$ATOO_DIR/setup-cuse.sh" || true
    fi

  # Systemd service
  - |
    cat > /etc/systemd/system/atoo-studio.service <<EOF
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
    EOF
  - systemctl daemon-reload
  - systemctl enable --now atoo-studio.service

final_message: "Atoo Studio is ready on https://$HOSTNAME:3010"
CLOUDINIT

# ── Create VM ──
info "Creating VM $VMID..."

qm create "$VMID" \
  --name "$VM_HOSTNAME" \
  --memory "$RAM" \
  --cores "$CORES" \
  --sockets 1 \
  --cpu host \
  --net0 "virtio,bridge=$BRIDGE" \
  --scsihw virtio-scsi-pci \
  --boot order=scsi0 \
  --agent 1 \
  --onboot 1

# Import cloud image as disk
info "Importing cloud image as disk..."
qm importdisk "$VMID" "$CLOUD_IMG_PATH" "$STORAGE" --format qcow2 2>/dev/null
qm set "$VMID" --scsi0 "$STORAGE:vm-${VMID}-disk-0"

# Resize disk
if [ "$DISK_SIZE" -gt 2 ]; then
  qm resize "$VMID" scsi0 "${DISK_SIZE}G"
fi

# Cloud-init drive
qm set "$VMID" --ide2 "$STORAGE:cloudinit"
qm set "$VMID" --ciuser root
qm set "$VMID" --ipconfig0 ip=dhcp
qm set "$VMID" --cicustom "user=local:snippets/atoo-studio-${VMID}.yaml"

if [ -n "$SSH_KEY" ]; then
  # Write SSH key to temp file for qm
  KEYFILE=$(mktemp)
  echo "$SSH_KEY" > "$KEYFILE"
  qm set "$VMID" --sshkeys "$KEYFILE"
  rm -f "$KEYFILE"
fi

ok "VM $VMID created."

# ── Start VM ──
info "Starting VM..."
qm start "$VMID"

# Wait for QEMU guest agent to report IP
info "Waiting for VM to boot and get IP (this may take a few minutes)..."
VM_IP=""
for i in $(seq 1 120); do
  VM_IP=$(qm guest cmd "$VMID" network-get-interfaces 2>/dev/null \
    | grep -oP '"ip-address"\s*:\s*"\K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
    | grep -v '^127\.' \
    | head -1) || true
  [ -n "$VM_IP" ] && break
  sleep 2
done

# ── Done ──
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Atoo Studio VM is ready!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  VM ID:         ${BOLD}$VMID${NC}"
echo -e "  Hostname:      ${BOLD}$VM_HOSTNAME${NC}"
echo -e "  Resources:     ${BOLD}${CORES} cores, ${RAM}MB RAM, ${DISK_SIZE}GB disk${NC}"
echo -e "  CUSE/Serial:   ${BOLD}Full support (VM)${NC}"
if [ -n "$VM_IP" ]; then
  echo -e "  Access:        ${BOLD}https://${VM_IP}:3010${NC}"
else
  warn "Could not detect VM IP. Install qemu-guest-agent inside the VM."
  echo -e "  Access:        ${BOLD}https://<vm-ip>:3010${NC}"
fi
echo ""
echo -e "  SSH:           ${CYAN}ssh root@${VM_IP:-<vm-ip>}${NC}"
echo -e "  Console:       ${CYAN}qm terminal $VMID${NC}"
echo -e "  Logs:          ${CYAN}ssh root@${VM_IP:-<vm-ip>} journalctl -u atoo-studio -f${NC}"
echo ""
echo -e "${YELLOW}Note: Cloud-init provisioning runs in the background after boot.${NC}"
echo -e "${YELLOW}Atoo Studio will be available once provisioning completes (2-5 minutes).${NC}"
echo -e "${YELLOW}Check progress: ssh root@${VM_IP:-<vm-ip>} cloud-init status${NC}"
echo ""
