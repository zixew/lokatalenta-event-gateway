import crypto from 'node:crypto';
import { loadContracts } from '../domain/contracts.js';
import {
  isPlainObject,
  normalizeAndValidateEvent,
  redactPiiText,
} from '../domain/normalize.js';
import type { EventSeverity, NormalizedEvent, TargetZone } from '../domain/types.js';

export type GitHubMapResult =
  | { kind: 'ping'; zen: string }
  | { kind: 'event'; event: NormalizedEvent }
  | { kind: 'ignored'; githubEvent: string }
  | { kind: 'error'; message: string };

const ACTOR_AGENT_PATTERNS: Array<[RegExp, number]> = [
  [/rizco/i, 0],
  [/bram/i, 1],
  [/prana/i, 2],
  [/satria/i, 3],
  [/arka/i, 4],
  [/gibran/i, 21],
  [/farel|faza/i, 5],
  [/bagas|bimo/i, 6],
  [/hendrawan/i, 18],
  [/danu/i, 19],
  [/nadia/i, 20],
  [/qonita/i, 7],
  [/qaisar/i, 8],
  [/pandu/i, 9],
  [/raditya/i, 10],
  [/damar|deva/i, 11],
  [/tara/i, 12],
  [/rendra/i, 16],
  [/saskia/i, 17],
  [/reza/i, 22],
  [/surya|dimas/i, 13],
  [/triastuti/i, 14],
  [/agung/i, 15],
  [/maya/i, 23],
];

function resolveAgentIdByActorOrRepo(
  actorHints: Array<string | undefined>,
  repoName: string,
  fallbackAgentId = 5,
): number {
  for (const hint of actorHints) {
    if (!hint) continue;
    for (const [pattern, agentId] of ACTOR_AGENT_PATTERNS) {
      if (pattern.test(hint)) {
        return agentId;
      }
    }
  }

  const lowerRepo = repoName.toLowerCase();
  if (lowerRepo.includes('docs')) return 12;
  if (lowerRepo.includes('gateway')) return 6;
  if (lowerRepo.includes('backlog') || lowerRepo.includes('sprint')) return 2;
  if (lowerRepo.includes('office-3d')) return 5;
  if (lowerRepo.includes('lokatalenta')) return 5;

  return fallbackAgentId;
}

function resolveIssueAgentByLabels(
  labels: unknown,
  actorHints: Array<string | undefined>,
  repoName: string,
): number {
  if (Array.isArray(labels)) {
    const labelNames = labels
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isPlainObject(item) && typeof item.name === 'string') return item.name;
        return '';
      })
      .join(' ')
      .toLowerCase();

    if (/\bqa\b|test|bug/i.test(labelNames)) return 7;
    if (/sec|security|pdp|auth/i.test(labelNames)) return 17;
    if (/devops|infra|ci|cd|deploy/i.test(labelNames)) return 11;
    if (/doc/i.test(labelNames)) return 12;
    if (/arch/i.test(labelNames)) return 3;
    if (/ux|ui|lounge|design/i.test(labelNames)) return 13;
  }

  return resolveAgentIdByActorOrRepo(actorHints, repoName, 7);
}

function truncate(str: string, maxLen: number): string {
  const clean = redactPiiText(str).trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(1, maxLen - 1))}…`;
}

function makeDeliveryEventId(
  githubEvent: string,
  deliveryId: string | undefined,
  rawBody: Buffer,
): string {
  if (deliveryId && deliveryId.trim().length > 0) {
    const candidate = `gh-${deliveryId.trim()}`;
    return candidate.length <= 128 ? candidate : candidate.slice(0, 128);
  }
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 24);
  return `gh-${githubEvent}-${digest}`.slice(0, 128);
}

function getRepoInfo(payload: Record<string, unknown>): {
  name: string;
  fullName: string;
} | null {
  if (!isPlainObject(payload.repository)) {
    return null;
  }
  const repo = payload.repository;
  const fullName =
    typeof repo.full_name === 'string' && repo.full_name.trim()
      ? repo.full_name.trim()
      : typeof repo.name === 'string' && repo.name.trim()
        ? repo.name.trim()
        : '';
  const name =
    typeof repo.name === 'string' && repo.name.trim()
      ? repo.name.trim()
      : fullName.split('/').pop() ?? '';

  if (!fullName || !name) {
    return null;
  }
  return { name, fullName };
}

export function mapGitHubWebhookToEvent(params: {
  githubEvent: string;
  deliveryId?: string;
  payload: Record<string, unknown>;
  rawBody: Buffer;
}): GitHubMapResult {
  const { githubEvent, deliveryId, payload, rawBody } = params;
  const eventName = githubEvent.trim().toLowerCase();

  if (eventName === 'ping') {
    const zen = typeof payload.zen === 'string' ? payload.zen : 'Keep it logically awesome.';
    return { kind: 'ping', zen };
  }

  const supportedEvents = new Set([
    'push',
    'pull_request',
    'pull_request_review',
    'issues',
  ]);
  if (!supportedEvents.has(eventName)) {
    return { kind: 'ignored', githubEvent: eventName };
  }

  const repo = getRepoInfo(payload);
  if (!repo) {
    return { kind: 'error', message: 'Missing or invalid payload.repository' };
  }

  const contracts = loadContracts();
  const senderLogin =
    isPlainObject(payload.sender) && typeof payload.sender.login === 'string'
      ? payload.sender.login
      : undefined;
  const eventId = makeDeliveryEventId(eventName, deliveryId, rawBody);

  if (eventName === 'push') {
    const ref = typeof payload.ref === 'string' ? payload.ref : 'refs/heads/main';
    const branch = ref.replace(/^refs\/heads\//, '') || 'main';
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const headCommit = isPlainObject(payload.head_commit)
      ? payload.head_commit
      : isPlainObject(commits[0])
        ? (commits[0] as Record<string, unknown>)
        : null;

    const sha =
      headCommit && typeof headCommit.id === 'string'
        ? headCommit.id
        : typeof payload.after === 'string'
          ? payload.after
          : '';
    const shortSha = sha ? sha.slice(0, 12) : null;
    const commitMsg =
      headCommit && typeof headCommit.message === 'string' && headCommit.message.trim()
        ? headCommit.message.split('\n')[0].trim()
        : `Push to ${branch}`;

    const commitAuthor =
      headCommit && isPlainObject(headCommit.author) ? headCommit.author : null;
    const pusher = isPlainObject(payload.pusher) ? payload.pusher : null;

    const authorHints: Array<string | undefined> = [
      commitAuthor && typeof commitAuthor.name === 'string' ? commitAuthor.name : undefined,
      commitAuthor && typeof commitAuthor.username === 'string'
        ? commitAuthor.username
        : undefined,
      pusher && typeof pusher.name === 'string' ? pusher.name : undefined,
      senderLogin,
    ];

    const agentId = resolveAgentIdByActorOrRepo(authorHints, repo.name, 5);
    const agent = contracts.agentsById.get(agentId) ?? contracts.agents[0];
    const actorDisplay = authorHints.find((h) => Boolean(h)) ?? 'Contributor';

    const result = normalizeAndValidateEvent({
      id: eventId,
      timestamp: new Date().toISOString(),
      source: 'github',
      type: 'github.commit',
      divisionId: agent.divisionId,
      agentId: agent.id,
      entityId: shortSha,
      title: truncate(`Push to ${repo.name}/${branch}: ${commitMsg}`, 160),
      summary: truncate(
        `${redactPiiText(actorDisplay)} pushed ${commits.length || 1} commit(s) to ${repo.fullName} (${branch}): ${commitMsg}`,
        500,
      ),
      targetZone: 'workspace',
      targetFloor: agent.defaultFloor,
      severity: 'info',
      metadata: {
        repository: repo.fullName,
        branch,
        commitCount: commits.length || (headCommit ? 1 : 0),
        sha: shortSha,
        actor: redactPiiText(actorDisplay),
      },
    });

    if (!result.ok) {
      return { kind: 'error', message: result.details.join('; ') };
    }
    return { kind: 'event', event: result.event };
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_review') {
    if (!isPlainObject(payload.pull_request)) {
      return { kind: 'error', message: 'Missing or invalid payload.pull_request' };
    }
    const pr = payload.pull_request;
    const action = typeof payload.action === 'string' ? payload.action : 'opened';
    const prNumber = typeof pr.number === 'number' ? pr.number : 0;
    const prTitle =
      typeof pr.title === 'string' && pr.title.trim()
        ? pr.title.trim()
        : `Pull Request #${prNumber}`;
    const merged = pr.merged === true;

    const prUser =
      isPlainObject(pr.user) && typeof pr.user.login === 'string'
        ? pr.user.login
        : undefined;
    const requestedReviewer =
      isPlainObject(payload.requested_reviewer) &&
      typeof payload.requested_reviewer.login === 'string'
        ? payload.requested_reviewer.login
        : undefined;
    const reviewUser =
      isPlainObject(payload.review) &&
      isPlainObject(payload.review.user) &&
      typeof payload.review.user.login === 'string'
        ? payload.review.user.login
        : undefined;

    let agentId: number;
    let severity: EventSeverity = 'info';
    let targetZone: TargetZone = 'workspace';
    let stateLabel = action;

    if (action === 'closed' && merged) {
      agentId = resolveAgentIdByActorOrRepo([prUser, senderLogin], repo.name, 0);
      severity = 'success';
      targetZone = 'boardroom';
      stateLabel = 'merged';
    } else if (action === 'closed') {
      agentId = resolveAgentIdByActorOrRepo([prUser, senderLogin], repo.name, 6);
      severity = 'warning';
      targetZone = 'workspace';
      stateLabel = 'closed';
    } else if (
      action === 'review_requested' ||
      eventName === 'pull_request_review'
    ) {
      agentId = resolveAgentIdByActorOrRepo(
        [requestedReviewer, reviewUser, senderLogin],
        repo.name,
        7,
      );
      severity = 'info';
      targetZone = 'boardroom';
    } else {
      agentId = resolveAgentIdByActorOrRepo([prUser, senderLogin], repo.name, 6);
      severity = 'info';
      targetZone = 'workspace';
    }

    const agent = contracts.agentsById.get(agentId) ?? contracts.agents[0];
    const entityId = prNumber > 0 ? `PR-${prNumber}` : null;

    const result = normalizeAndValidateEvent({
      id: eventId,
      timestamp: new Date().toISOString(),
      source: 'github',
      type: 'github.pr',
      divisionId: agent.divisionId,
      agentId: agent.id,
      entityId,
      title: truncate(`PR #${prNumber} ${stateLabel} in ${repo.name}: ${prTitle}`, 160),
      summary: truncate(
        `Pull request PR #${prNumber} (${stateLabel}) on ${repo.fullName}: ${prTitle}`,
        500,
      ),
      targetZone,
      targetFloor: agent.defaultFloor,
      severity,
      metadata: {
        repository: repo.fullName,
        prNumber,
        action,
        merged,
      },
    });

    if (!result.ok) {
      return { kind: 'error', message: result.details.join('; ') };
    }
    return { kind: 'event', event: result.event };
  }

  // issues
  if (!isPlainObject(payload.issue)) {
    return { kind: 'error', message: 'Missing or invalid payload.issue' };
  }
  const issue = payload.issue;
  const action = typeof payload.action === 'string' ? payload.action : 'opened';
  const issueNumber = typeof issue.number === 'number' ? issue.number : 0;
  const issueTitle =
    typeof issue.title === 'string' && issue.title.trim()
      ? issue.title.trim()
      : `Issue #${issueNumber}`;
  const issueUser =
    isPlainObject(issue.user) && typeof issue.user.login === 'string'
      ? issue.user.login
      : undefined;

  const agentId = resolveIssueAgentByLabels(
    issue.labels,
    [issueUser, senderLogin],
    repo.name,
  );
  const agent = contracts.agentsById.get(agentId) ?? contracts.agents[7];

  const severity: EventSeverity =
    action === 'closed'
      ? 'success'
      : action === 'opened' || action === 'reopened'
        ? 'warning'
        : 'info';

  const result = normalizeAndValidateEvent({
    id: eventId,
    timestamp: new Date().toISOString(),
    source: 'github',
    type: 'github.issue',
    divisionId: agent.divisionId,
    agentId: agent.id,
    entityId: issueNumber > 0 ? `ISSUE-${issueNumber}` : null,
    title: truncate(`Issue #${issueNumber} ${action} in ${repo.name}: ${issueTitle}`, 160),
    summary: truncate(
      `Issue #${issueNumber} (${action}) in ${repo.fullName}: ${issueTitle}`,
      500,
    ),
    targetZone: agent.defaultZone,
    targetFloor: agent.defaultFloor,
    severity,
    metadata: {
      repository: repo.fullName,
      issueNumber,
      action,
    },
  });

  if (!result.ok) {
    return { kind: 'error', message: result.details.join('; ') };
  }
  return { kind: 'event', event: result.event };
}
