import crypto from 'node:crypto';

export function computeHmacSha256Hex(rawBody: Buffer | string, secret: string): string {
  const buf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

export function verifyHmacSignature(
  rawBody: Buffer,
  headerValue: string | undefined,
  secret: string,
  options: { requireSha256Prefix?: boolean } = {},
): boolean {
  if (!secret || !headerValue || typeof headerValue !== 'string') {
    return false;
  }

  const trimmed = headerValue.trim();
  let hexDigest: string;

  if (trimmed.toLowerCase().startsWith('sha256=')) {
    hexDigest = trimmed.slice('sha256='.length);
  } else if (options.requireSha256Prefix) {
    return false;
  } else {
    hexDigest = trimmed;
  }

  if (!/^[0-9a-f]{64}$/i.test(hexDigest)) {
    return false;
  }

  const expectedHex = computeHmacSha256Hex(rawBody, secret);
  const actualBuf = Buffer.from(hexDigest.toLowerCase(), 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export function verifyBearerToken(
  authorizationHeader: string | undefined,
  expectedSecret: string,
): boolean {
  if (!expectedSecret || !authorizationHeader || typeof authorizationHeader !== 'string') {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) {
    return false;
  }

  const providedToken = match[1].trim();
  if (!providedToken) {
    return false;
  }

  const providedHash = crypto.createHash('sha256').update(providedToken).digest();
  const expectedHash = crypto.createHash('sha256').update(expectedSecret).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}
