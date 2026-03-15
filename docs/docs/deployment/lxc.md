---
sidebar_position: 3
---

# LXC / LXD

Pre-built LXC container images are available for lightweight deployment without Docker overhead.

## Download

LXC images are attached to each [GitHub Release](https://github.com/atooai/atoo-studio/releases) for both architectures:

- `atoo-studio-lxc-amd64.tar.gz`
- `atoo-studio-lxc-arm64.tar.gz`

## Import with LXD

```bash
# Download the image
wget https://github.com/atooai/atoo-studio/releases/latest/download/atoo-studio-lxc-amd64.tar.gz

# Import as LXD image
lxc image import atoo-studio-lxc-amd64.tar.gz --alias atoo-studio

# Launch a container
lxc launch atoo-studio my-atoo-studio

# Check the IP
lxc list my-atoo-studio
```

Access the workspace at `https://<container-ip>:3010`.
