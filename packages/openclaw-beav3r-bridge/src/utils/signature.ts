import crypto from 'node:crypto';

export function hmac(raw: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}
