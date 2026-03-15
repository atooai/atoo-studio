---
sidebar_position: 2
---

# App Preview

Atoo Studio includes a built-in application preview powered by Chrome DevTools Protocol (CDP). Instead of iframes, it uses pixel streaming from a headless Chrome instance — eliminating cross-origin issues entirely.

## How It Works

1. An agent starts a dev server and reports it via the `report_tcp_services` MCP tool
2. The preview panel automatically detects the service
3. A headless Chrome instance navigates to the service URL
4. The rendered page is streamed as pixels to your browser

## Responsive Testing

Test your application across different device form factors:

| Preset | Resolution |
|--------|-----------|
| iPhone | Mobile viewport with touch emulation |
| Pixel | Android mobile viewport |
| iPad | Tablet viewport |
| Desktop | Full-width viewport |

You can also set custom viewports, adjust zoom levels, toggle device pixel ratio, and enable touch emulation.

## DevTools Integration

Open Chrome DevTools directly inside the workspace panel — inspect elements, debug JavaScript, profile performance, and monitor network requests without leaving Atoo Studio.

## Quality Control

Adjust the streaming quality with a slider to balance between visual fidelity and bandwidth usage. Lower quality is useful for slower connections.

## Service Detection

When agents report TCP services via MCP, they appear in the "Forwarded Connections" panel with direct links. The preview panel can target any reported service.

Custom `Host` headers can be injected for multi-domain testing scenarios.
