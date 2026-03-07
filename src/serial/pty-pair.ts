import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

interface NativeBinding {
  createPtyPair(): { masterFd: number; slavePath: string };
  getModemBits(masterFd: number): { dtr: boolean; rts: boolean };
  setModemBits(masterFd: number, dtr: boolean, rts: boolean): void;
  readMaster(masterFd: number, buffer: Buffer): number;
  writeMaster(masterFd: number, buffer: Buffer, length: number): number;
  closeFd(fd: number): void;
}

// Try loading from build/Release first (node-gyp output location)
let native: NativeBinding;
try {
  native = require(path.join(__dirname, 'native', 'build', 'Release', 'pty_pair.node'));
} catch {
  // Fallback: when running from dist/, the native dir is at the source location
  native = require(path.join(__dirname, '..', '..', '..', 'src', 'serial', 'native', 'build', 'Release', 'pty_pair.node'));
}

export interface PtyPair {
  masterFd: number;
  slavePath: string;
  write(data: Buffer): number;
  read(): Buffer | null;
  getModemBits(): { dtr: boolean; rts: boolean };
  setModemBits(dtr: boolean, rts: boolean): void;
  close(): void;
  closed: boolean;
  controlSignalsSupported: false;
}

const READ_BUF_SIZE = 4096;

export function createPtyPair(): PtyPair {
  const { masterFd, slavePath } = native.createPtyPair();
  const readBuf = Buffer.alloc(READ_BUF_SIZE);
  let closed = false;

  return {
    masterFd,
    slavePath,
    controlSignalsSupported: false as const,
    get closed() { return closed; },

    write(data: Buffer): number {
      if (closed) return -1;
      return native.writeMaster(masterFd, data, data.length);
    },

    read(): Buffer | null {
      if (closed) return null;
      const n = native.readMaster(masterFd, readBuf);
      if (n <= 0) return null; // 0 = EAGAIN, -1 = closed/error
      return Buffer.from(readBuf.subarray(0, n));
    },

    getModemBits(): { dtr: boolean; rts: boolean } {
      if (closed) return { dtr: false, rts: false };
      return native.getModemBits(masterFd);
    },

    setModemBits(dtr: boolean, rts: boolean): void {
      if (!closed) native.setModemBits(masterFd, dtr, rts);
    },

    close(): void {
      if (!closed) {
        closed = true;
        native.closeFd(masterFd);
      }
    },
  };
}
