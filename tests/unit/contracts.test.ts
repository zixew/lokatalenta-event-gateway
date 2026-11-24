import { describe, expect, it } from 'vitest';
import { loadContracts } from '../../src/domain/contracts.js';

describe('M1 canonical contracts', () => {
  it('loads 6 divisions and 24 unique canonical agents (0..23)', () => {
    const contracts = loadContracts();
    expect(contracts.divisions).toHaveLength(6);
    expect(contracts.agents).toHaveLength(24);

    const seenIds = new Set<number>();
    for (const agent of contracts.agents) {
      expect(seenIds.has(agent.id)).toBe(false);
      seenIds.add(agent.id);
      const div = contracts.divisionsById.get(agent.divisionId);
      expect(div).toBeDefined();
      expect(div!.agentIds).toContain(agent.id);
    }
    expect(seenIds.size).toBe(24);
  });

  it('keeps gateway port 4101 out of avoidedHostPorts and defines strict 13-key schema', () => {
    const contracts = loadContracts();
    const gw = contracts.ecosystemPorts.services.find(
      (s) => s.id === 'lokatalenta-event-gateway',
    );
    expect(gw?.apiPort).toBe(4101);
    expect(contracts.ecosystemPorts.avoidedHostPorts).not.toContain(4101);
    expect(contracts.eventSchema.additionalProperties).toBe(false);
    expect(contracts.eventSchema.required).toHaveLength(13);
  });
});
