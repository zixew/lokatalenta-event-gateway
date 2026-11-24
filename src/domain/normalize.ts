import crypto from 'node:crypto';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { loadContracts } from './contracts.js';
import type { DivisionId, NormalizedEvent } from './types.js';

const CANONICAL_EVENT_KEYS = new Set<string>([
  'id',
  'timestamp',
  'source',
  'type',
  'divisionId',
  'agentId',
  'entityId',
  'title',
  'summary',
  'targetZone',
  'targetFloor',
  'severity',
  'metadata',
]);

const FORBIDDEN_PII_KEY_PATTERN =
  /^(email|phone|nik|fullName|full_name|address|ktp|password|token)$/i;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NIK_PATTERN = /\b\d{16}\b/g;
const ID_PHONE_PATTERN = /(?:\+62|08)\d{8,12}/g;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function redactPiiText(text: string): string {
  return text
    .replace(EMAIL_PATTERN, '[REDACTED]')
    .replace(NIK_PATTERN, '[REDACTED]')
    .replace(ID_PHONE_PATTERN, '[REDACTED]');
}

export function sanitizePiiValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;

  if (typeof value === 'string') {
    return redactPiiText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePiiValue(item, depth + 1));
  }

  if (isPlainObject(value)) {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_PII_KEY_PATTERN.test(k)) {
        continue;
      }
      const nextVal = sanitizePiiValue(v, depth + 1);
      if (nextVal !== undefined) {
        cleaned[k] = nextVal;
      }
    }
    return cleaned;
  }

  return value;
}

export function sanitizeMetadata(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    return {};
  }
  const sanitized = sanitizePiiValue(raw, 0);
  return isPlainObject(sanitized) ? sanitized : {};
}

type ValidateFn = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string; params?: unknown }> | null;
};

let compiledValidator: ValidateFn | null = null;

function getEventValidator(): ValidateFn {
  if (compiledValidator) return compiledValidator;

  const contracts = loadContracts();
  const AjvCtor = (
    (Ajv2020Module as unknown as { default?: new (opts: Record<string, unknown>) => unknown })
      .default ?? Ajv2020Module
  ) as new (opts: Record<string, unknown>) => {
    compile: (schema: Record<string, unknown>) => ValidateFn;
  };
  const addFormats = (
    (addFormatsModule as unknown as { default?: (ajv: unknown) => void }).default ??
    addFormatsModule
  ) as (ajv: unknown) => void;

  const ajv = new AjvCtor({
    allErrors: true,
    strict: false,
    coerceTypes: false,
    removeAdditional: false,
  });
  addFormats(ajv);
  compiledValidator = ajv.compile(contracts.eventSchema);
  return compiledValidator;
}

export type NormalizeEventResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; details: string[] };

export function normalizeAndValidateEvent(input: unknown): NormalizeEventResult {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      details: ['Event payload must be a JSON plain object'],
    };
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => !CANONICAL_EVENT_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      details: unknownKeys.map((k) => `Unknown property not allowed: ${k}`),
    };
  }

  const contracts = loadContracts();
  const errors: string[] = [];

  // Normalize id
  let id: unknown = input.id;
  if (id === undefined) {
    id = crypto.randomUUID();
  } else if (typeof id === 'string') {
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      errors.push('id must not be empty or whitespace-only');
    } else {
      id = trimmed;
    }
  }

  // Normalize timestamp
  let timestamp: unknown = input.timestamp;
  if (timestamp === undefined) {
    timestamp = new Date().toISOString();
  }

  // Normalize title & summary (caller-required, must not be defaulted)
  let title: unknown = input.title;
  if (typeof title === 'string') {
    const trimmed = redactPiiText(title.trim());
    if (trimmed.length === 0) {
      errors.push('title must not be empty or whitespace-only');
    } else {
      title = trimmed.length > 160 ? trimmed.slice(0, 160) : trimmed;
    }
  }

  let summary: unknown = input.summary;
  if (typeof summary === 'string') {
    const trimmed = redactPiiText(summary.trim());
    if (trimmed.length === 0) {
      errors.push('summary must not be empty or whitespace-only');
    } else {
      summary = trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
    }
  }

  // Normalize entityId (null if undefined or empty/whitespace-only)
  let entityId: unknown = input.entityId;
  if (entityId === undefined) {
    entityId = null;
  } else if (typeof entityId === 'string') {
    const trimmed = redactPiiText(entityId.trim());
    entityId = trimmed.length === 0 ? null : trimmed;
  }

  // Lookup agent/division for defaults ONLY when targetZone/targetFloor are undefined
  const agent =
    typeof input.agentId === 'number' && Number.isInteger(input.agentId)
      ? contracts.agentsById.get(input.agentId)
      : undefined;
  const division =
    typeof input.divisionId === 'string'
      ? contracts.divisionsById.get(input.divisionId as DivisionId)
      : undefined;

  const targetZone =
    input.targetZone !== undefined
      ? input.targetZone
      : (agent?.defaultZone ?? division?.defaultZone ?? 'workspace');

  const targetFloor =
    input.targetFloor !== undefined
      ? input.targetFloor
      : (agent?.defaultFloor ?? division?.defaultFloor ?? 2);

  const severity = input.severity !== undefined ? input.severity : 'info';

  let metadata: unknown;
  if (input.metadata === undefined) {
    metadata = {};
  } else if (isPlainObject(input.metadata)) {
    metadata = sanitizeMetadata(input.metadata);
  } else {
    metadata = input.metadata;
  }

  if (errors.length > 0) {
    return { ok: false, details: errors };
  }

  const candidate: Record<string, unknown> = {
    id,
    timestamp,
    source: input.source,
    type: input.type,
    divisionId: input.divisionId,
    agentId: input.agentId,
    entityId,
    title,
    summary,
    targetZone,
    targetFloor,
    severity,
    metadata,
  };

  const validate = getEventValidator();
  const valid = validate(candidate);
  if (!valid) {
    const ajvErrors = (validate.errors ?? []).map((err) => {
      const loc = err.instancePath ? err.instancePath.replace(/^\//, '') : 'root';
      return `${loc}: ${err.message ?? 'invalid'}`;
    });
    return { ok: false, details: ajvErrors };
  }

  return {
    ok: true,
    event: candidate as unknown as NormalizedEvent,
  };
}
