import { loadContracts } from './contracts.js';
import type {
  AgentSnapshotState,
  DivisionId,
  DivisionSnapshotState,
  EventType,
  GatewaySnapshot,
  GatewayStats,
  NormalizedEvent,
  SnapshotDelta,
  StoredEventRow,
} from './types.js';

function deriveActivity(type: EventType, event: NormalizedEvent): string {
  switch (type) {
    case 'github.commit':
      return `Committed code (${event.entityId ?? 'repo'})`;
    case 'github.pr':
      return `Pull request activity (${event.entityId ?? 'PR'})`;
    case 'github.issue':
      return `Issue triage (${event.entityId ?? 'issue'})`;
    case 'backlog.updated':
      return `Backlog update (${event.entityId ?? 'backlog'})`;
    case 'sprint.updated':
      return `Sprint planning (${event.entityId ?? 'sprint'})`;
    case 'doc.updated':
      return `Documentation update (${event.entityId ?? 'docs'})`;
    case 'lms.activity':
      return `LMS activity (${event.entityId ?? 'lms'})`;
    case 'agent.task.completed':
      return `Completed task (${event.entityId ?? 'task'})`;
    default:
      return 'Active';
  }
}

export class SnapshotProjection {
  private readonly agentsById = new Map<number, AgentSnapshotState>();
  private readonly divisionsById = new Map<DivisionId, DivisionSnapshotState>();
  private recentEvents: NormalizedEvent[] = [];
  private readonly recentLimit: number;
  private totalEvents = 0;
  private readonly eventsBySource: Record<string, number> = {};
  private readonly eventsByDivision: Record<string, number> = {};
  private readonly eventsBySeverity: Record<string, number> = {};
  private lastEventSeq = 0;
  private lastEventAt: string | null = null;
  private readonly startedAtMs = Date.now();
  private readonly startedAtIso = new Date(this.startedAtMs).toISOString();

  constructor(recentLimit = 50) {
    this.recentLimit = Math.max(1, recentLimit);
    const contracts = loadContracts();

    for (const div of contracts.divisions) {
      this.divisionsById.set(div.id, {
        ...div,
        activeAgentCount: div.agentIds.length,
        eventCount: 0,
        lastEventAt: null,
      });
    }

    for (const agent of contracts.agents) {
      this.agentsById.set(agent.id, {
        ...agent,
        currentZone: agent.defaultZone,
        currentFloor: agent.defaultFloor,
        status: 'online',
        activity: 'idle',
        lastEventId: null,
        lastEventType: null,
        lastEventTitle: null,
        lastEventAt: null,
        lastUpdatedAt: null,
        eventCount: 0,
      });
    }
  }

  hydrateFromRows(
    rowsAsc: StoredEventRow[],
    totals?: {
      totalEvents: number;
      lastEventSeq: number;
      bySource: Record<string, number>;
      byDivision: Record<string, number>;
      bySeverity: Record<string, number>;
    },
  ): void {
    for (const row of rowsAsc) {
      this.applyEvent(row.event, row.seq);
    }
    if (totals) {
      this.totalEvents = totals.totalEvents;
      this.lastEventSeq = totals.lastEventSeq;
      for (const [k, v] of Object.entries(totals.bySource)) {
        this.eventsBySource[k] = v;
      }
      for (const [k, v] of Object.entries(totals.byDivision)) {
        this.eventsByDivision[k] = v;
        const div = this.divisionsById.get(k as DivisionId);
        if (div) div.eventCount = v;
      }
      for (const [k, v] of Object.entries(totals.bySeverity)) {
        this.eventsBySeverity[k] = v;
      }
    }
  }

  applyEvent(
    event: NormalizedEvent,
    seq: number,
    clientCounts: { wsClients?: number; sseClients?: number } = {},
  ): SnapshotDelta {
    this.totalEvents += 1;
    this.lastEventSeq = Math.max(this.lastEventSeq, seq);
    this.lastEventAt = event.timestamp;
    this.eventsBySource[event.source] = (this.eventsBySource[event.source] ?? 0) + 1;
    this.eventsByDivision[event.divisionId] =
      (this.eventsByDivision[event.divisionId] ?? 0) + 1;
    this.eventsBySeverity[event.severity] =
      (this.eventsBySeverity[event.severity] ?? 0) + 1;

    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.recentLimit) {
      this.recentEvents.length = this.recentLimit;
    }

    const agent = this.agentsById.get(event.agentId);
    if (!agent) {
      throw new Error(`Unknown agentId ${event.agentId} in normalized event`);
    }

    agent.currentZone = event.targetZone;
    agent.currentFloor = event.targetFloor;
    agent.status = event.severity === 'alert' ? 'busy' : 'online';
    agent.activity = deriveActivity(event.type, event);
    agent.lastEventId = event.id;
    agent.lastEventType = event.type;
    agent.lastEventTitle = event.title;
    agent.lastEventAt = event.timestamp;
    agent.lastUpdatedAt = event.timestamp;
    agent.eventCount += 1;

    const division = this.divisionsById.get(event.divisionId);
    if (!division) {
      throw new Error(`Unknown divisionId ${event.divisionId} in normalized event`);
    }
    division.eventCount += 1;
    division.lastEventAt = event.timestamp;

    return {
      agent: { ...agent },
      division: { ...division },
      stats: this.getStats(clientCounts),
    };
  }

  getStats(clientCounts: { wsClients?: number; sseClients?: number } = {}): GatewayStats {
    const wsClients = clientCounts.wsClients ?? 0;
    const sseClients = clientCounts.sseClients ?? 0;
    const uptimeSeconds = Math.floor((Date.now() - this.startedAtMs) / 1000);
    return {
      totalEvents: this.totalEvents,
      eventsBySource: { ...this.eventsBySource },
      eventsByDivision: { ...this.eventsByDivision },
      eventsBySeverity: { ...this.eventsBySeverity },
      lastEventSeq: this.lastEventSeq,
      lastEventAt: this.lastEventAt,
      wsClients,
      sseClients,
      connectedWsClients: wsClients,
      connectedSseClients: sseClients,
      uptimeSeconds,
      startedAt: this.startedAtIso,
    };
  }

  getSnapshot(
    clientCounts: { wsClients?: number; sseClients?: number } = {},
  ): GatewaySnapshot {
    const agents = Array.from(this.agentsById.values())
      .sort((a, b) => a.id - b.id)
      .map((a) => ({ ...a }));
    const divisions = Array.from(this.divisionsById.values()).map((d) => ({ ...d }));

    return {
      agents,
      divisions,
      recentEvents: this.recentEvents.map((e) => ({ ...e })),
      stats: this.getStats(clientCounts),
    };
  }

  getRecentEventsCount(): number {
    return this.recentEvents.length;
  }

  getTotalEvents(): number {
    return this.totalEvents;
  }
}
