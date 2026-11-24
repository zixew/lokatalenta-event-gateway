import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DivisionId,
  EventSeverity,
  EventSource,
  EventType,
  NormalizedEvent,
  StoredEventRow,
  TargetFloor,
  TargetZone,
} from '../domain/types.js';

interface RawEventRow {
  seq: number;
  id: string;
  timestamp: string;
  source: string;
  type: string;
  division_id: string;
  agent_id: number;
  entity_id: string | null;
  title: string;
  summary: string;
  target_zone: string;
  target_floor: number;
  severity: string;
  metadata_json: string;
  created_at: string;
}

export interface EventQueryFilters {
  limit?: number;
  divisionId?: string;
  type?: string;
  source?: string;
  agentId?: number;
  sinceSeq?: number;
  sinceTimestamp?: string;
}

function mapRow(row: RawEventRow): StoredEventRow {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }

  const event: NormalizedEvent = {
    id: row.id,
    timestamp: row.timestamp,
    source: row.source as EventSource,
    type: row.type as EventType,
    divisionId: row.division_id as DivisionId,
    agentId: Number(row.agent_id),
    entityId: row.entity_id,
    title: row.title,
    summary: row.summary,
    targetZone: row.target_zone as TargetZone,
    targetFloor: Number(row.target_floor) as TargetFloor,
    severity: row.severity as EventSeverity,
    metadata,
  };

  return {
    seq: Number(row.seq),
    event,
    createdAt: row.created_at,
  };
}

export class SqliteEventStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        division_id TEXT NOT NULL,
        agent_id INTEGER NOT NULL,
        entity_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        target_zone TEXT NOT NULL,
        target_floor INTEGER NOT NULL,
        severity TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_events_seq_desc ON events (seq DESC);
      CREATE INDEX IF NOT EXISTS idx_events_division_seq ON events (division_id, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type_seq ON events (type, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_events_source_seq ON events (source, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_events_agent_seq ON events (agent_id, seq DESC);
    `);
  }

  insertIdempotent(event: NormalizedEvent): {
    seq: number;
    event: NormalizedEvent;
    duplicate: boolean;
  } {
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        id, timestamp, source, type, division_id, agent_id,
        entity_id, title, summary, target_zone, target_floor,
        severity, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      event.id,
      event.timestamp,
      event.source,
      event.type,
      event.divisionId,
      event.agentId,
      event.entityId,
      event.title,
      event.summary,
      event.targetZone,
      event.targetFloor,
      event.severity,
      JSON.stringify(event.metadata),
    );

    if (Number(result.changes) === 1) {
      return {
        seq: Number(result.lastInsertRowid),
        event,
        duplicate: false,
      };
    }

    const existing = this.db
      .prepare('SELECT * FROM events WHERE id = ?')
      .get(event.id) as RawEventRow | undefined;

    if (!existing) {
      throw new Error(`Failed to retrieve existing event for duplicate id=${event.id}`);
    }

    const mapped = mapRow(existing);
    return {
      seq: mapped.seq,
      event: mapped.event,
      duplicate: true,
    };
  }

  queryEvents(filters: EventQueryFilters = {}): StoredEventRow[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filters.divisionId) {
      conditions.push('division_id = ?');
      params.push(filters.divisionId);
    }
    if (filters.type) {
      conditions.push('type = ?');
      params.push(filters.type);
    }
    if (filters.source) {
      conditions.push('source = ?');
      params.push(filters.source);
    }
    if (filters.agentId !== undefined) {
      conditions.push('agent_id = ?');
      params.push(filters.agentId);
    }
    if (filters.sinceSeq !== undefined) {
      conditions.push('seq > ?');
      params.push(filters.sinceSeq);
    }
    if (filters.sinceTimestamp !== undefined) {
      conditions.push('julianday(timestamp) > julianday(?)');
      params.push(filters.sinceTimestamp);
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderDirection =
      filters.sinceSeq !== undefined || filters.sinceTimestamp !== undefined
        ? 'ASC'
        : 'DESC';

    const sql = `SELECT * FROM events ${whereClause} ORDER BY seq ${orderDirection} LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as unknown as RawEventRow[];
    return rows.map(mapRow);
  }

  resolveSeqForLastEventId(lastEventId: string): number | null {
    const trimmed = lastEventId.trim();
    if (!trimmed) return null;

    const byId = this.db
      .prepare('SELECT seq FROM events WHERE id = ?')
      .get(trimmed) as { seq: number } | undefined;
    if (byId !== undefined) {
      return Number(byId.seq);
    }

    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed);
    }

    return null;
  }

  getEventsSince(seq: number, limit = 200): StoredEventRow[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = this.db
      .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(seq, safeLimit) as unknown as RawEventRow[];
    return rows.map(mapRow);
  }

  getLatestSeq(): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events')
      .get() as { max_seq: number } | undefined;
    return Number(row?.max_seq ?? 0);
  }

  getTotalCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM events')
      .get() as { cnt: number } | undefined;
    return Number(row?.cnt ?? 0);
  }

  getHydrationData(recentLimit = 50): {
    rowsAsc: StoredEventRow[];
    totalEvents: number;
    lastEventSeq: number;
    bySource: Record<string, number>;
    byDivision: Record<string, number>;
    bySeverity: Record<string, number>;
  } {
    const safeLimit = Math.min(Math.max(recentLimit, 1), 500);
    const recentDesc = this.db
      .prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?')
      .all(safeLimit) as unknown as RawEventRow[];
    const rowsAsc = recentDesc.reverse().map(mapRow);

    const totalEvents = this.getTotalCount();
    const lastEventSeq = this.getLatestSeq();

    const bySource: Record<string, number> = {};
    for (const r of this.db
      .prepare('SELECT source AS k, COUNT(*) AS cnt FROM events GROUP BY source')
      .all() as Array<{ k: string; cnt: number }>) {
      bySource[r.k] = Number(r.cnt);
    }

    const byDivision: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        'SELECT division_id AS k, COUNT(*) AS cnt FROM events GROUP BY division_id',
      )
      .all() as Array<{ k: string; cnt: number }>) {
      byDivision[r.k] = Number(r.cnt);
    }

    const bySeverity: Record<string, number> = {};
    for (const r of this.db
      .prepare('SELECT severity AS k, COUNT(*) AS cnt FROM events GROUP BY severity')
      .all() as Array<{ k: string; cnt: number }>) {
      bySeverity[r.k] = Number(r.cnt);
    }

    return {
      rowsAsc,
      totalEvents,
      lastEventSeq,
      bySource,
      byDivision,
      bySeverity,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
