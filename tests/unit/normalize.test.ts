import { describe, expect, it } from 'vitest';
import { normalizeAndValidateEvent } from '../../src/domain/normalize.js';

describe('normalizeAndValidateEvent', () => {
  it('fills optional defaults and supports agentId 0 without falsy bug', () => {
    const res = normalizeAndValidateEvent({
      source: 'backlog',
      type: 'backlog.updated',
      divisionId: 'executive',
      agentId: 0,
      title: '  Release gate review  ',
      summary: '  Rizco Renova approved M2 readiness.  ',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(Object.keys(res.event)).toHaveLength(13);
    expect(res.event.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(res.event.timestamp))).toBe(false);
    expect(res.event.agentId).toBe(0);
    expect(res.event.entityId).toBeNull();
    expect(res.event.targetZone).toBe('workspace');
    expect(res.event.targetFloor).toBe(3);
    expect(res.event.severity).toBe('info');
    expect(res.event.metadata).toEqual({});
    expect(res.event.title).toBe('Release gate review');
    expect(res.event.summary).toBe('Rizco Renova approved M2 readiness.');
  });

  it('normalizes empty/whitespace entityId to null', () => {
    const res = normalizeAndValidateEvent({
      source: 'docs',
      type: 'doc.updated',
      divisionId: 'devops',
      agentId: 12,
      entityId: '   ',
      title: 'Updated ADR',
      summary: 'Updated architecture doc',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.event.entityId).toBeNull();
  });

  it('rejects missing required fields, whitespace-only strings, unknown keys, and invalid bounds', () => {
    const missingSummary = normalizeAndValidateEvent({
      source: 'backlog',
      type: 'backlog.updated',
      divisionId: 'engineering',
      agentId: 5,
      title: 'Missing summary',
    });
    expect(missingSummary.ok).toBe(false);

    const blankTitle = normalizeAndValidateEvent({
      source: 'backlog',
      type: 'backlog.updated',
      divisionId: 'engineering',
      agentId: 5,
      title: '   ',
      summary: 'Valid summary',
    });
    expect(blankTitle.ok).toBe(false);

    const unknownProp = normalizeAndValidateEvent({
      source: 'backlog',
      type: 'backlog.updated',
      divisionId: 'engineering',
      agentId: 5,
      title: 'Valid',
      summary: 'Valid summary',
      extraKey: 'nope',
    });
    expect(unknownProp.ok).toBe(false);

    const invalidAgent = normalizeAndValidateEvent({
      source: 'backlog',
      type: 'backlog.updated',
      divisionId: 'engineering',
      agentId: 99,
      title: 'Invalid agent',
      summary: 'Valid summary',
    });
    expect(invalidAgent.ok).toBe(false);

    const invalidZone = normalizeAndValidateEvent({
      source: 'backlog',
      type: 'backlog.updated',
      divisionId: 'engineering',
      agentId: 5,
      title: 'Invalid zone',
      summary: 'Valid summary',
      targetZone: 'meeting-rooms',
    });
    expect(invalidZone.ok).toBe(false);

    const invalidFloor = normalizeAndValidateEvent({
      source: 'backlog',
      type: 'backlog.updated',
      divisionId: 'engineering',
      agentId: 5,
      title: 'Invalid floor',
      summary: 'Valid summary',
      targetFloor: 99,
    });
    expect(invalidFloor.ok).toBe(false);
  });

  it('recursively strips forbidden PII keys and redacts email, NIK, and phone numbers', () => {
    const res = normalizeAndValidateEvent({
      source: 'lms-psikotes',
      type: 'lms.activity',
      divisionId: 'lounge',
      agentId: 13,
      title: 'Activity for budi@example.com',
      summary: 'NIK 3174011234560001 phone +6281234567890 and 081987654321',
      metadata: {
        email: 'budi@example.com',
        phone: '+6281234567890',
        nik: '3174011234560001',
        fullName: 'Budi Santoso',
        address: 'Jl. Sudirman',
        ktp: '3174011234560001',
        password: 'secret',
        token: 'tok-123',
        nested: {
          password: 'nested-secret',
          note: 'Reach out to alice@corp.id or 081234567890',
        },
        safeMetric: 42,
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const serialized = JSON.stringify(res.event);
    expect(serialized).not.toContain('budi@example.com');
    expect(serialized).not.toContain('alice@corp.id');
    expect(serialized).not.toContain('3174011234560001');
    expect(serialized).not.toContain('+6281234567890');
    expect(serialized).not.toContain('081987654321');
    expect(serialized).not.toContain('081234567890');
    expect(serialized).not.toContain('nested-secret');
    expect(serialized).not.toMatch(
      /"(?:email|phone|nik|fullName|address|ktp|password|token)"\s*:/i,
    );
    expect(res.event.metadata.safeMetric).toBe(42);
  });
});
