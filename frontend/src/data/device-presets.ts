export interface DevicePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  category: 'phone' | 'tablet' | 'laptop' | 'desktop';
  dpr: number;
  isMobile: boolean;
  hasTouch: boolean;
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'iphone-se',    name: 'iPhone SE',         width: 375,  height: 667,  category: 'phone',   dpr: 2, isMobile: true,  hasTouch: true },
  { id: 'iphone-14',    name: 'iPhone 14',         width: 390,  height: 844,  category: 'phone',   dpr: 3, isMobile: true,  hasTouch: true },
  { id: 'iphone-14-pm', name: 'iPhone 14 Pro Max', width: 430,  height: 932,  category: 'phone',   dpr: 3, isMobile: true,  hasTouch: true },
  { id: 'pixel-7',      name: 'Pixel 7',           width: 412,  height: 915,  category: 'phone',   dpr: 2.625, isMobile: true, hasTouch: true },
  { id: 'galaxy-s23',   name: 'Galaxy S23',        width: 360,  height: 780,  category: 'phone',   dpr: 3, isMobile: true,  hasTouch: true },
  { id: 'ipad-mini',    name: 'iPad Mini',         width: 768,  height: 1024, category: 'tablet',  dpr: 2, isMobile: true,  hasTouch: true },
  { id: 'ipad-air',     name: 'iPad Air',          width: 820,  height: 1180, category: 'tablet',  dpr: 2, isMobile: true,  hasTouch: true },
  { id: 'ipad-pro-12',  name: 'iPad Pro 12.9"',    width: 1024, height: 1366, category: 'tablet',  dpr: 2, isMobile: true,  hasTouch: true },
  { id: 'laptop',       name: 'Laptop',            width: 1366, height: 768,  category: 'laptop',  dpr: 1, isMobile: false, hasTouch: false },
  { id: 'desktop-hd',   name: 'Desktop HD',        width: 1920, height: 1080, category: 'desktop', dpr: 1, isMobile: false, hasTouch: false },
];
