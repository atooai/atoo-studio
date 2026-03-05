// File type icons using material-file-icons (MIT licensed, 377 SVG icons)
import { getIcon } from 'material-file-icons';

// Cache for file icons
const iconCache = new Map<string, string>();

export function getFileIconSvg(name: string): string {
  let cached = iconCache.get(name);
  if (cached) return cached;
  const result = getIcon(name);
  cached = result.svg;
  iconCache.set(name, cached);
  return cached;
}

// Folder uses simple arrow characters (user preferred the original style)
export const FOLDER_ARROW_CLOSED = '▸';
export const FOLDER_ARROW_OPEN = '▾';
