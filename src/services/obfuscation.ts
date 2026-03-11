// Simple XOR + base64 obfuscation — NOT encryption, just prevents casual reading
const XOR_KEY = 'atoo-studio-ssh-obfuscation-key-2024';

export function obfuscate(plaintext: string): string {
  const buf = Buffer.from(plaintext, 'utf-8');
  for (let i = 0; i < buf.length; i++) {
    buf[i] ^= XOR_KEY.charCodeAt(i % XOR_KEY.length);
  }
  return buf.toString('base64');
}

export function deobfuscate(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  for (let i = 0; i < buf.length; i++) {
    buf[i] ^= XOR_KEY.charCodeAt(i % XOR_KEY.length);
  }
  return buf.toString('utf-8');
}
