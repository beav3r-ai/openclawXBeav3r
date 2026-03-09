import crypto from 'node:crypto';

export function computeHmacSha256(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyHmac(rawBody: string, secret: string, provided: string): boolean {
  const expected = computeHmacSha256(rawBody, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided || '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
