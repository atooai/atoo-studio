---
sidebar_position: 10
---

# Serial Devices

Atoo Studio can bridge USB serial devices (ESP32, Arduino, etc.) from your browser to the server, enabling agents to flash firmware and monitor serial output.

## How It Works

1. An agent calls the `request_serial_device` MCP tool
2. You're prompted in the browser to select a USB serial device via Web Serial API
3. A virtual PTY is created on the server, bridging browser ↔ device
4. The agent uses the returned PTY path with standard serial tools

## Usage Examples

```bash
# Monitor serial output
screen /dev/pts/XX 115200

# Flash ESP32 firmware
esptool.py --port /dev/pts/XX flash_id

# ESP-IDF monitor
idf.py -p /dev/pts/XX monitor
```

## Control Signals

### CUSE Mode (Linux only)

For full DTR/RTS control (required for auto-reset sequences during flashing):

```bash
sudo bash setup-cuse.sh
```

This creates a CUSE (Character Device in Userspace) device that supports hardware control signals.

### PTY Fallback (all platforms)

On macOS or when CUSE is not configured, a PTY pair provides basic serial I/O. Hardware control signals are not available — you'll need to hold the BOOT button manually when flashing.
