import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CanonicalAgent,
  CanonicalDivision,
  DivisionId,
  EcosystemPortsContract,
} from './types.js';

export interface LoadedContracts {
  contractsDir: string;
  divisions: CanonicalDivision[];
  divisionsById: Map<DivisionId, CanonicalDivision>;
  agents: CanonicalAgent[];
  agentsById: Map<number, CanonicalAgent>;
  collaborationPairs: Array<Record<string, unknown>>;
  eventSchema: Record<string, unknown>;
  ecosystemPorts: EcosystemPortsContract;
}

function resolveContractsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../../contracts'),
    path.resolve(currentDir, '../../../contracts'),
    path.resolve(currentDir, '../../../../contracts'),
    path.resolve(process.cwd(), 'contracts'),
  ];

  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'divisions.json')) &&
      fs.existsSync(path.join(candidate, 'agents.json')) &&
      fs.existsSync(path.join(candidate, 'event-schema.json')) &&
      fs.existsSync(path.join(candidate, 'ecosystem-ports.json'))
    ) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate contracts directory. Checked: ${candidates.join(', ')}`,
  );
}

function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

let cachedContracts: LoadedContracts | null = null;

export function loadContracts(): LoadedContracts {
  if (cachedContracts) return cachedContracts;

  const contractsDir = resolveContractsDir();

  const divisionsPayload = readJsonFile<{ divisions: CanonicalDivision[] }>(
    path.join(contractsDir, 'divisions.json'),
  );
  const agentsPayload = readJsonFile<{
    agents: CanonicalAgent[];
    collaborationPairs: Array<Record<string, unknown>>;
  }>(path.join(contractsDir, 'agents.json'));
  const eventSchema = readJsonFile<Record<string, unknown>>(
    path.join(contractsDir, 'event-schema.json'),
  );
  const ecosystemPorts = readJsonFile<EcosystemPortsContract>(
    path.join(contractsDir, 'ecosystem-ports.json'),
  );

  const divisionsById = new Map<DivisionId, CanonicalDivision>();
  for (const division of divisionsPayload.divisions) {
    divisionsById.set(division.id, division);
  }

  const agentsById = new Map<number, CanonicalAgent>();
  for (const agent of agentsPayload.agents) {
    agentsById.set(agent.id, agent);
  }

  cachedContracts = {
    contractsDir,
    divisions: divisionsPayload.divisions,
    divisionsById,
    agents: agentsPayload.agents,
    agentsById,
    collaborationPairs: agentsPayload.collaborationPairs ?? [],
    eventSchema,
    ecosystemPorts,
  };

  return cachedContracts;
}
