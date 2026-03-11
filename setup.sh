#!/bin/bash
set -e

# Install system dependencies for ccproxy (headless mode).
# Must be run as root (sudo ./setup.sh).
#
# NOTE: If using Docker preview mode (docker/preview/build.sh), these
# system deps are not needed — everything runs inside the container.
# Only ffmpeg is still useful on the host for encoding screen recordings.

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root (sudo $0)"
  exit 1
fi

echo "=== ccproxy system setup ==="

# --- Chrome / Puppeteer dependencies ---
echo ""
echo "Installing Chrome dependencies for browser preview..."

CHROME_PKGS=(
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libatspi2.0-0
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2
  libgbm1 libcairo2 libpango-1.0-0
)

# ffmpeg is used for encoding screen recordings to WebM
RECORDING_PKGS=(
  ffmpeg
)

if command -v apt-get &>/dev/null; then
  # libasound2 was renamed to libasound2t64 in Ubuntu 24.04+
  if apt-cache show libasound2t64 &>/dev/null 2>&1; then
    CHROME_PKGS+=(libasound2t64)
  else
    CHROME_PKGS+=(libasound2)
  fi
  apt-get install -y "${CHROME_PKGS[@]}" "${RECORDING_PKGS[@]}"
elif command -v dnf &>/dev/null; then
  dnf install -y atk at-spi2-atk cups-libs libXcomposite libXdamage \
    libXfixes libXrandr mesa-libgbm cairo pango alsa-lib \
    ffmpeg
elif command -v pacman &>/dev/null; then
  pacman -S --noconfirm atk at-spi2-atk libcups libxcomposite libxdamage \
    libxfixes libxrandr mesa cairo pango alsa-lib \
    ffmpeg
else
  echo "Error: No supported package manager found (apt-get, dnf, pacman)."
  echo "Install Chrome dependencies manually."
  exit 1
fi

echo "All dependencies installed (Chrome libs, ffmpeg)."

echo ""
echo "=== Setup complete ==="
echo "You can now run: npx ccproxy"
