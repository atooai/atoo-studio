export interface DeviceFrameDef {
  id: string;
  name: string;
  bezel: { top: number; right: number; bottom: number; left: number };
  outerRadius: number;
  innerRadius: number;
  bodyColor: string;
  borderColor: string;
  /** Cutout overlaying the screen (Dynamic Island, punch-hole) */
  screenCutout?: {
    type: 'dynamic-island' | 'punch-hole';
    width: number;
    height: number;
    top: number;
    borderRadius: number;
  };
  /** Camera dot in the bezel */
  bezelCamera?: { position: 'top'; diameter: number };
  /** Side buttons as % of body height */
  sideButtons?: Array<{
    side: 'left' | 'right';
    topPercent: number;
    heightPercent: number;
  }>;
  /** Status bar overlay config */
  statusBar: {
    os: 'ios' | 'android';
    centerY: number; // Y center of items at 390px reference width
    time: string;
  };
}

export const DEVICE_FRAMES: DeviceFrameDef[] = [
  {
    id: 'iphone',
    name: 'iPhone',
    bezel: { top: 6, right: 6, bottom: 6, left: 6 },
    outerRadius: 52,
    innerRadius: 48,
    bodyColor: '#111113',
    borderColor: '#38383a',
    screenCutout: {
      type: 'dynamic-island',
      width: 126,
      height: 37,
      top: 11,
      borderRadius: 19,
    },
    sideButtons: [
      { side: 'right', topPercent: 22, heightPercent: 7 },
      { side: 'left', topPercent: 16, heightPercent: 2.5 },
      { side: 'left', topPercent: 24, heightPercent: 5 },
      { side: 'left', topPercent: 31, heightPercent: 5 },
    ],
    statusBar: { os: 'ios', centerY: 29, time: '9:41' },
  },
  {
    id: 'ipad',
    name: 'iPad',
    bezel: { top: 12, right: 12, bottom: 12, left: 12 },
    outerRadius: 20,
    innerRadius: 14,
    bodyColor: '#1d1d1f',
    borderColor: '#48484a',
    bezelCamera: { position: 'top', diameter: 6 },
    sideButtons: [
      { side: 'right', topPercent: 8, heightPercent: 5 },
    ],
    statusBar: { os: 'ios', centerY: 12, time: '9:41' },
  },
  {
    id: 'android-phone',
    name: 'Android Phone',
    bezel: { top: 6, right: 6, bottom: 6, left: 6 },
    outerRadius: 38,
    innerRadius: 34,
    bodyColor: '#0f0f0f',
    borderColor: '#2c2c2e',
    screenCutout: {
      type: 'punch-hole',
      width: 14,
      height: 14,
      top: 9,
      borderRadius: 7,
    },
    sideButtons: [
      { side: 'right', topPercent: 20, heightPercent: 6 },
      { side: 'right', topPercent: 30, heightPercent: 9 },
    ],
    statusBar: { os: 'android', centerY: 14, time: '12:00' },
  },
  {
    id: 'android-tablet',
    name: 'Android Tablet',
    bezel: { top: 10, right: 10, bottom: 10, left: 10 },
    outerRadius: 16,
    innerRadius: 12,
    bodyColor: '#1a1a1c',
    borderColor: '#3a3a3c',
    bezelCamera: { position: 'top', diameter: 5 },
    statusBar: { os: 'android', centerY: 12, time: '12:00' },
  },
];
