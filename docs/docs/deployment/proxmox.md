---
sidebar_position: 4
---

# Proxmox

One-command installation scripts are available for Proxmox environments.

## LXC Container

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/main/proxmox/lxc.sh)"
```

This creates a privileged LXC container with Atoo Studio pre-installed. The script handles:

- Container creation with appropriate resources
- Network configuration
- Atoo Studio installation and service setup

## Virtual Machine

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/atooai/atoo-studio/main/proxmox/vm.sh)"
```

Creates a full VM with Atoo Studio installed. Use this when you need:

- Full kernel access (e.g., for Docker-in-VM)
- Hardware passthrough (USB serial devices)
- Stronger isolation

## After Installation

Once the container or VM is running, access Atoo Studio at:

```
https://<ip-address>:3010
```

The IP address is displayed at the end of the installation script output.
