import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key));
});

export function validateNewPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}

export async function hashPassword(password: string) {
  if (!validateNewPassword(password)) throw new Error('Use a password between 12 and 128 characters.');
  const salt = randomBytes(16).toString('hex');
  return `scrypt:v1:${salt}:${(await derive(password, salt)).toString('hex')}`;
}

// A missing account still performs the same expensive derivation.
const dummyHash = `scrypt:v1:${'0'.repeat(32)}:${'0'.repeat(128)}`;
export async function verifyPassword(password: string, stored = dummyHash) {
  const [algorithm, version, salt, hex] = stored.split(':');
  if (algorithm !== 'scrypt' || version !== 'v1' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hex ?? '')) return false;
  return timingSafeEqual(await derive(password, salt!), Buffer.from(hex!, 'hex'));
}
