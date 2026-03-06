export interface DevicePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  category: 'phone' | 'tablet' | 'laptop' | 'desktop';
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'iphone-se',    name: 'iPhone SE',         width: 375,  height: 667,  category: 'phone' },
  { id: 'iphone-14',    name: 'iPhone 14',         width: 390,  height: 844,  category: 'phone' },
  { id: 'iphone-14-pm', name: 'iPhone 14 Pro Max', width: 430,  height: 932,  category: 'phone' },
  { id: 'pixel-7',      name: 'Pixel 7',           width: 412,  height: 915,  category: 'phone' },
  { id: 'galaxy-s23',   name: 'Galaxy S23',        width: 360,  height: 780,  category: 'phone' },
  { id: 'ipad-mini',    name: 'iPad Mini',         width: 768,  height: 1024, category: 'tablet' },
  { id: 'ipad-air',     name: 'iPad Air',          width: 820,  height: 1180, category: 'tablet' },
  { id: 'ipad-pro-12',  name: 'iPad Pro 12.9"',    width: 1024, height: 1366, category: 'tablet' },
  { id: 'laptop',       name: 'Laptop',            width: 1366, height: 768,  category: 'laptop' },
  { id: 'desktop-hd',   name: 'Desktop HD',        width: 1920, height: 1080, category: 'desktop' },
];
