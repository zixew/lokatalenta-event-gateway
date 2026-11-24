export type DivisionId =
  | 'executive'
  | 'architecture'
  | 'engineering'
  | 'qa'
  | 'devops'
  | 'lounge';

export type EventSource =
  | 'backlog'
  | 'sprint-planner'
  | 'docs'
  | 'lms-psikotes'
  | 'github'
  | 'office-sim';

export type EventType =
  | 'backlog.updated'
  | 'sprint.updated'
  | 'doc.updated'
  | 'lms.activity'
  | 'agent.task.completed'
  | 'github.commit'
  | 'github.pr'
  | 'github.issue';

export type TargetZone =
  | 'workspace'
  | 'boardroom'
  | 'cafeteria'
  | 'lobby'
  | 'lounge'
  | 'gym'
  | 'musholla';

export type TargetFloor = 1 | 2 | 3;

export type EventSeverity = 'info' | 'success' | 'warning' | 'alert';

export interface NormalizedEvent {
  id: string;
  timestamp: string;
  source: EventSource;
  type: EventType;
  divisionId: DivisionId;
  agentId: number;
  entityId: string | null;
  title: string;
  summary: string;
  targetZone: TargetZone;
  targetFloor: TargetFloor;
  severity: EventSeverity;
  metadata: Record<string, unknown>;
}

export interface CanonicalDivision {
  id: DivisionId;
  name: string;
  shortName: string;
  motto: string;
  color: string;
  threeColor: string;
  defaultFloor: TargetFloor;
  defaultZone: TargetZone;
  agentIds: number[];
}

export interface CanonicalAgent {
  id: number;
  name: string;
  shortName: string;
  role: string;
  divisionId: DivisionId;
  category: string;
  avatar: string;
  skills: {
    primary: string[];
    stack: string[];
  };
  methodology: string[];
  certifications: string[];
  avatarStyle: Record<string, string>;
  defaultZone: TargetZone;
  defaultFloor: TargetFloor;
}

export interface EcosystemServiceEntry {
  id: string;
  name: string;
  localPath: string;
  githubRepo: string;
  githubUrl: string;
  apiPort: number;
  devUiPort: number | null;
  baseUrl: string;
  devUiUrl?: string;
  wsUrl?: string;
  sseUrl?: string;
  healthPath: string;
}

export interface EcosystemPortsContract {
  version: string;
  githubOwner: string;
  avoidedHostPorts: number[];
  services: EcosystemServiceEntry[];
}

export interface AgentSnapshotState extends CanonicalAgent {
  currentZone: TargetZone;
  currentFloor: TargetFloor;
  status: 'online' | 'busy' | 'idle';
  activity: string;
  lastEventId: string | null;
  lastEventType: EventType | null;
  lastEventTitle: string | null;
  lastEventAt: string | null;
  lastUpdatedAt: string | null;
  eventCount: number;
}

export interface DivisionSnapshotState extends CanonicalDivision {
  activeAgentCount: number;
  eventCount: number;
  lastEventAt: string | null;
}

export interface GatewayStats {
  totalEvents: number;
  eventsBySource: Record<string, number>;
  eventsByDivision: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  lastEventSeq: number;
  lastEventAt: string | null;
  wsClients: number;
  sseClients: number;
  connectedWsClients: number;
  connectedSseClients: number;
  uptimeSeconds: number;
  startedAt: string;
}

export interface GatewaySnapshot {
  agents: AgentSnapshotState[];
  divisions: DivisionSnapshotState[];
  recentEvents: NormalizedEvent[];
  stats: GatewayStats;
}

export interface SnapshotDelta {
  agent: AgentSnapshotState;
  division: DivisionSnapshotState;
  stats: GatewayStats;
}

export interface StoredEventRow {
  seq: number;
  event: NormalizedEvent;
  createdAt: string;
}
