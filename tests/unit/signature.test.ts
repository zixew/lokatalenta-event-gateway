import { describe, expect, it } from 'vitest';
import {
  computeHmacSha256Hex,
  verifyBearerToken,
  verifyHmacSignature,
} from '../../src/webhooks/signature.js';

describe('HMAC and Bearer verification', () => {
  const secret = 'super-secret-value';
  const rawBody = Buffer.from('{"hello":"world"}', 'utf8');

  it('verifies sha256= prefixed and unprefixed HMAC signatures', () => {
    const hex = computeHmacSha256Hex(rawBody, secret);
    expect(verifyHmacSignature(rawBody, `sha256=${hex}`, secret)).toBe(true);
    expect(verifyHmacSignature(rawBody, hex, secret)).toBe(true);
    expect(
      verifyHmacSignature(rawBody, hex, secret, { requireSha256Prefix: true }),
    ).toBe(false);
  });

  it('rejects wrong secrets, tampered payloads, and malformed signatures', () => {
    const hex = computeHmacSha256Hex(rawBody, secret);
    expect(
      verifyHmacSignature(Buffer.from('{"hello":"tampered"}'), `sha256=${hex}`, secret),
    ).toBe(false);
    expect(verifyHmacSignature(rawBody, `sha256=${hex}`, 'wrong-secret')).toBe(false);
    expect(verifyHmacSignature(rawBody, 'sha256=not-hex', secret)).toBe(false);
    expect(verifyHmacSignature(rawBody, 'sha256=deadbeef', secret)).toBe(false);
    expect(verifyHmacSignature(rawBody, undefined, secret)).toBe(false);
    expect(verifyHmacSignature(rawBody, `sha256=${hex}`, '')).toBe(false);
  });

  it('verifies Bearer tokens via SHA-256 timingSafeEqual', () => {
    expect(verifyBearerToken(`Bearer ${secret}`, secret)).toBe(true);
    expect(verifyBearerToken(`bearer ${secret}`, secret)).toBe(true);
    expect(verifyBearerToken('Bearer wrong-token', secret)).toBe(false);
    expect(verifyBearerToken('Basic abc', secret)).toBe(false);
    expect(verifyBearerToken(undefined, secret)).toBe(false);
  });
});
