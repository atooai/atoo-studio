import React from 'react';
import { DeviceFrameDef } from '../../data/device-frames';

interface DeviceFrameProps {
  frame: DeviceFrameDef;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  children: React.ReactNode;
}

/* ---------- SVG status-bar icons ---------- */

function SignalIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size * 0.7} viewBox="0 0 17 12">
      <rect x="0" y="9" width="3" height="3" rx="0.5" fill="currentColor"/>
      <rect x="4.5" y="6" width="3" height="6" rx="0.5" fill="currentColor"/>
      <rect x="9" y="3" width="3" height="9" rx="0.5" fill="currentColor"/>
      <rect x="13.5" y="0" width="3" height="12" rx="0.5" fill="currentColor"/>
    </svg>
  );
}

function WifiIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size * 0.85} viewBox="0 0 16 14">
      <circle cx="8" cy="12" r="1.5" fill="currentColor"/>
      <path d="M5 9.5c.8-1.2 1.8-1.8 3-1.8s2.2.6 3 1.8" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      <path d="M2 6.5C3.5 4.5 5.5 3.5 8 3.5s4.5 1 6 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      <path d="M0 3.5C2 1.2 4.8 0 8 0s6 1.2 8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
    </svg>
  );
}

function BatteryIcon({ width, height }: { width: number; height: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 27 12">
      <rect x="0.5" y="0.5" width="22" height="11" rx="2.5" stroke="currentColor" strokeWidth="1" fill="none"/>
      <rect x="2" y="2" width="16" height="8" rx="1.5" fill="currentColor"/>
      <path d="M24 3.5v5a2.5 2.5 0 0 0 0-5z" fill="currentColor" opacity="0.4"/>
    </svg>
  );
}

/* ---------- StatusBar (DOM overlay) ---------- */

function StatusBar({ width, os, time }: { width: number; os: 'ios' | 'android'; time: string }) {
  const s = width / 390;
  return (
    <div className="device-status-bar" style={{
      height: os === 'ios' ? 54 * s : 28 * s,
      paddingTop: os === 'ios' ? 18 * s : 4 * s,
      paddingLeft: 16 * s, paddingRight: 16 * s,
      fontSize: 15 * s, fontWeight: 600,
      boxSizing: 'border-box',
    }}>
      <span>{time}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 * s }}>
        <SignalIcon size={17 * s} />
        <WifiIcon size={16 * s} />
        <BatteryIcon width={27 * s} height={12 * s} />
      </span>
    </div>
  );
}

/* ---------- DeviceFrame component ---------- */

export function DeviceFrame({ frame, viewportWidth, viewportHeight, scale, children }: DeviceFrameProps) {
  const { bezel, outerRadius, innerRadius, bodyColor, borderColor, screenCutout, bezelCamera, sideButtons } = frame;
  const totalW = viewportWidth + bezel.left + bezel.right;
  const totalH = viewportHeight + bezel.top + bezel.bottom;

  return (
    <div
      className="device-frame-transform"
      style={{
        width: totalW,
        height: totalH,
        transform: scale !== 1 ? `scale(${scale})` : undefined,
        transformOrigin: '0 0',
      }}
    >
      <div
        className="device-frame-body"
        style={{
          width: totalW,
          height: totalH,
          borderRadius: outerRadius,
          background: bodyColor,
          border: `1px solid ${borderColor}`,
          padding: `${bezel.top}px ${bezel.right}px ${bezel.bottom}px ${bezel.left}px`,
          boxSizing: 'border-box',
          position: 'relative',
        }}
      >
        {/* Bezel camera (iPad, Android tablet) */}
        {bezelCamera?.position === 'top' && (
          <div style={{
            position: 'absolute',
            width: bezelCamera.diameter,
            height: bezelCamera.diameter,
            borderRadius: '50%',
            background: '#111',
            border: '1px solid #333',
            top: (bezel.top - bezelCamera.diameter) / 2,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2,
          }} />
        )}

        {/* Screen area */}
        <div
          className="device-frame-screen"
          style={{
            width: viewportWidth,
            height: viewportHeight,
            borderRadius: innerRadius,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {children}

          {/* Status bar overlay */}
          <StatusBar width={viewportWidth} os={frame.statusBar.os} time={frame.statusBar.time} />

          {/* Screen cutout overlay (Dynamic Island / punch-hole) */}
          {screenCutout && (
            <div
              className="device-frame-cutout"
              style={{
                position: 'absolute',
                top: screenCutout.top,
                left: '50%',
                transform: 'translateX(-50%)',
                width: screenCutout.width,
                height: screenCutout.height,
                borderRadius: screenCutout.borderRadius,
                background: '#000',
                pointerEvents: 'none',
                zIndex: 16,
              }}
            />
          )}
        </div>

        {/* Side buttons */}
        {sideButtons?.map((btn, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              [btn.side === 'left' ? 'left' : 'right']: -4,
              top: `${btn.topPercent}%`,
              height: `${btn.heightPercent}%`,
              width: 3,
              background: borderColor,
              borderRadius: btn.side === 'left' ? '2px 0 0 2px' : '0 2px 2px 0',
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------- Canvas drawing helpers ---------- */

function drawSignalToCanvas(ctx: CanvasRenderingContext2D, x: number, centerY: number, s: number) {
  ctx.fillStyle = '#fff';
  const bars = [
    { x: 0, y: 9, w: 3, h: 3 },
    { x: 4.5, y: 6, w: 3, h: 6 },
    { x: 9, y: 3, w: 3, h: 9 },
    { x: 13.5, y: 0, w: 3, h: 12 },
  ];
  const iconH = 12 * s;
  const topY = centerY - iconH / 2;
  for (const b of bars) {
    ctx.beginPath();
    ctx.roundRect(x + b.x * s, topY + b.y * s, b.w * s, b.h * s, 0.5 * s);
    ctx.fill();
  }
}

function drawWifiToCanvas(ctx: CanvasRenderingContext2D, x: number, centerY: number, s: number) {
  const iconH = 14 * s;
  const topY = centerY - iconH / 2;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(x + 8 * s, topY + 12 * s, 1.5 * s, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5 * s;
  ctx.lineCap = 'round';

  const arcs: [number, number, number, number][] = [
    [5, 9.5, 3, 1.8],
    [2, 6.5, 6, 3],
    [0, 3.5, 8, 3.5],
  ];
  for (const [startX, startY, cx, radius] of arcs) {
    ctx.beginPath();
    ctx.arc(x + (startX + cx) * s, topY + (startY + radius) * s, radius * s, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
}

function drawBatteryToCanvas(ctx: CanvasRenderingContext2D, x: number, centerY: number, s: number) {
  const iconH = 12 * s;
  const topY = centerY - iconH / 2;
  // Outline
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.roundRect(x + 0.5 * s, topY + 0.5 * s, 22 * s, 11 * s, 2.5 * s);
  ctx.stroke();
  // Fill
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(x + 2 * s, topY + 2 * s, 16 * s, 8 * s, 1.5 * s);
  ctx.fill();
  // Nub
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.moveTo(x + 24 * s, topY + 3.5 * s);
  ctx.lineTo(x + 24 * s, topY + 8.5 * s);
  ctx.arc(x + 24 * s, topY + 6 * s, 2.5 * s, Math.PI * 0.5, -Math.PI * 0.5);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawStatusBarToCanvas(ctx: CanvasRenderingContext2D, frame: DeviceFrameDef, screenW: number, bx: number, by: number) {
  const s = screenW / 390;
  const centerY = by + frame.statusBar.centerY * s;
  const leftPad = bx + 16 * s;
  const rightEdge = bx + screenW - 16 * s;

  ctx.fillStyle = '#fff';
  ctx.font = `600 ${15 * s}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(frame.statusBar.time, leftPad, centerY);

  drawBatteryToCanvas(ctx, rightEdge - 25 * s, centerY, s);
  drawWifiToCanvas(ctx, rightEdge - 45 * s, centerY, s);
  drawSignalToCanvas(ctx, rightEdge - 65 * s, centerY, s);
}

/** Draw the full device (body, bezel, screen, status bar, cutout) onto a canvas at (x, y) */
function drawDeviceToCanvas(ctx: CanvasRenderingContext2D, frame: DeviceFrameDef, sourceCanvas: HTMLCanvasElement, x: number, y: number) {
  const { bezel, outerRadius, innerRadius, bodyColor, borderColor, screenCutout, bezelCamera, sideButtons } = frame;
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const totalW = sw + bezel.left + bezel.right;
  const totalH = sh + bezel.top + bezel.bottom;

  // Device body
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.roundRect(x, y, totalW, totalH, outerRadius);
  ctx.fill();

  // Body border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, totalW - 1, totalH - 1, outerRadius);
  ctx.stroke();

  // Side buttons
  if (sideButtons) {
    ctx.fillStyle = borderColor;
    for (const btn of sideButtons) {
      const btnTop = y + totalH * btn.topPercent / 100;
      const btnH = totalH * btn.heightPercent / 100;
      const btnX = btn.side === 'left' ? x - 2 : x + totalW - 1;
      ctx.beginPath();
      ctx.roundRect(btnX, btnTop, 3, btnH, btn.side === 'left' ? [2, 0, 0, 2] : [0, 2, 2, 0]);
      ctx.fill();
    }
  }

  // Bezel camera
  if (bezelCamera?.position === 'top') {
    const d = bezelCamera.diameter;
    const cx = x + totalW / 2;
    const cy = y + bezel.top / 2;
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Screen content (clipped to inner radius)
  const screenX = x + bezel.left;
  const screenY = y + bezel.top;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(screenX, screenY, sw, sh, innerRadius);
  ctx.clip();
  ctx.drawImage(sourceCanvas, screenX, screenY);
  ctx.restore();

  // Status bar
  drawStatusBarToCanvas(ctx, frame, sw, screenX, screenY);

  // Screen cutout
  if (screenCutout) {
    ctx.fillStyle = '#000';
    const cx = screenX + sw / 2 - screenCutout.width / 2;
    const cy = screenY + screenCutout.top;
    ctx.beginPath();
    ctx.roundRect(cx, cy, screenCutout.width, screenCutout.height, screenCutout.borderRadius);
    ctx.fill();
  }
}

/** Render a framed screenshot to an offscreen canvas and return base64 PNG */
export function captureFramedScreenshot(
  sourceCanvas: HTMLCanvasElement,
  frame: DeviceFrameDef,
): string {
  const { bezel } = frame;
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const totalW = sw + bezel.left + bezel.right;
  const totalH = sh + bezel.top + bezel.bottom;

  const c = document.createElement('canvas');
  c.width = totalW;
  c.height = totalH;
  const ctx = c.getContext('2d')!;

  drawDeviceToCanvas(ctx, frame, sourceCanvas, 0, 0);

  return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

/** Render a full mockup screenshot (gradient background + header + framed device) */
export function captureMockupScreenshot(
  sourceCanvas: HTMLCanvasElement,
  frame: DeviceFrameDef,
  opts: {
    bg1: string; bg2: string; gradient: boolean; gradientDir: string;
    headerText: string; headerColor: string; headerFont: string; headerSize: number;
  },
): string {
  const { bezel } = frame;
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const deviceTotalW = sw + bezel.left + bezel.right;
  const deviceTotalH = sh + bezel.top + bezel.bottom;
  const mockupW = Math.round(deviceTotalW * 1.35);
  const mockupH = Math.round(deviceTotalH * 1.3);
  const headerAreaH = (mockupH - deviceTotalH) * 0.6;

  const c = document.createElement('canvas');
  c.width = mockupW;
  c.height = mockupH;
  const ctx = c.getContext('2d')!;

  // Background
  if (opts.gradient) {
    let grd: CanvasGradient;
    switch (opts.gradientDir) {
      case 'to right': grd = ctx.createLinearGradient(0, 0, mockupW, 0); break;
      case 'to top': grd = ctx.createLinearGradient(0, mockupH, 0, 0); break;
      case '135deg': grd = ctx.createLinearGradient(0, 0, mockupW, mockupH); break;
      case '45deg': grd = ctx.createLinearGradient(mockupW, 0, 0, mockupH); break;
      default: grd = ctx.createLinearGradient(0, 0, 0, mockupH); break;
    }
    grd.addColorStop(0, opts.bg1);
    grd.addColorStop(1, opts.bg2);
    ctx.fillStyle = grd;
  } else {
    ctx.fillStyle = opts.bg1;
  }
  ctx.beginPath();
  ctx.roundRect(0, 0, mockupW, mockupH, 16);
  ctx.fill();

  // Header text
  const s = sw / 390;
  ctx.fillStyle = opts.headerColor;
  ctx.font = `700 ${opts.headerSize * s}px ${opts.headerFont}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.headerText, mockupW / 2, headerAreaH / 2);

  // Device
  const deviceX = (mockupW - deviceTotalW) / 2;
  const deviceY = headerAreaH;
  drawDeviceToCanvas(ctx, frame, sourceCanvas, deviceX, deviceY);

  return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
