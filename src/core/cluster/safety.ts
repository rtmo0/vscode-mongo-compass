import type { Document } from 'mongodb';
import type { ReplicaMember, SafetyReport } from './types';

const MAX_MEMBERS = 50;
const MAX_VOTING_MEMBERS = 7;

/** A member entry of a replica set config document. */
interface ConfigMember {
  _id: number;
  host: string;
  arbiterOnly?: boolean;
  priority?: number;
  votes?: number;
  hidden?: boolean;
  secondaryDelaySecs?: number;
  slaveDelay?: number;
  buildIndexes?: boolean;
}

const delayOf = (m: ConfigMember): number => Number(m.secondaryDelaySecs ?? m.slaveDelay ?? 0);
const votesOf = (m: ConfigMember): number => Number(m.votes ?? 1);
const priorityOf = (m: ConfigMember): number => Number(m.priority ?? (m.arbiterOnly ? 0 : 1));

/**
 * Check a replica set config before `replSetReconfig`, with the rules the
 * server enforces (so the user gets a readable message instead of a server
 * error) plus warnings about configurations that are legal but fragile.
 */
export function validateReplicaSetConfig(config: Document): SafetyReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const members = (config.members ?? []) as ConfigMember[];

  if (members.length === 0) {
    errors.push('A replica set needs at least one member.');
  }
  if (members.length > MAX_MEMBERS) {
    errors.push(`A replica set can have at most ${MAX_MEMBERS} members (has ${members.length}).`);
  }

  const ids = new Set<number>();
  const hosts = new Set<string>();
  for (const member of members) {
    if (ids.has(member._id)) {
      errors.push(`Duplicate member _id ${member._id}.`);
    }
    ids.add(member._id);
    const host = String(member.host).toLowerCase();
    if (hosts.has(host)) {
      errors.push(`Host ${member.host} is listed twice.`);
    }
    hosts.add(host);

    const votes = votesOf(member);
    const priority = priorityOf(member);
    if (votes !== 0 && votes !== 1) {
      errors.push(`${member.host}: votes must be 0 or 1.`);
    }
    if (priority < 0 || priority > 1000) {
      errors.push(`${member.host}: priority must be between 0 and 1000.`);
    }
    if (member.arbiterOnly && priority !== 0) {
      errors.push(`${member.host}: an arbiter must have priority 0.`);
    }
    if (member.hidden && priority !== 0) {
      errors.push(`${member.host}: a hidden member must have priority 0.`);
    }
    if (delayOf(member) > 0 && priority !== 0) {
      errors.push(`${member.host}: a delayed member must have priority 0.`);
    }
    if (delayOf(member) > 0 && !member.hidden) {
      warnings.push(`${member.host} is delayed but not hidden — clients may read stale data from it.`);
    }
    if (votes === 0 && priority !== 0) {
      errors.push(`${member.host}: a non-voting member must have priority 0.`);
    }
    if (member.buildIndexes === false && priority !== 0) {
      errors.push(`${member.host}: a member with buildIndexes: false must have priority 0.`);
    }
  }

  const voting = members.filter((m) => votesOf(m) === 1);
  if (voting.length > MAX_VOTING_MEMBERS) {
    errors.push(`At most ${MAX_VOTING_MEMBERS} members can vote (${voting.length} do).`);
  }
  const electable = members.filter((m) => votesOf(m) === 1 && priorityOf(m) > 0 && !m.arbiterOnly);
  if (members.length > 0 && electable.length === 0) {
    errors.push('No member can become primary (every member is an arbiter, hidden, delayed, non-voting or has priority 0).');
  }
  if (voting.length > 0 && voting.length % 2 === 0) {
    warnings.push(`${voting.length} voting members: an even number gives no extra fault tolerance over ${voting.length - 1}. Add an arbiter or a voting member, or make one member non-voting.`);
  }
  const arbiters = members.filter((m) => m.arbiterOnly);
  if (arbiters.length > 1) {
    warnings.push('More than one arbiter is not recommended.');
  }
  if (arbiters.length > 0) {
    warnings.push('With an arbiter, w:"majority" writes stall while a data-bearing member is down (PSA architecture).');
  }
  return { errors, warnings };
}

/**
 * Would the replica set still have a reachable voting majority after `next`
 * replaces the current config? Uses the live member health from `status`.
 */
export function checkMajorityAfter(next: Document, status: ReplicaMember[]): SafetyReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const healthy = new Set(status.filter((m) => m.health === 1).map((m) => m.host.toLowerCase()));
  const members = (next.members ?? []) as ConfigMember[];
  const voting = members.filter((m) => votesOf(m) === 1);
  const healthyVoting = voting.filter((m) => healthy.has(String(m.host).toLowerCase()));
  const majority = Math.floor(voting.length / 2) + 1;

  if (healthyVoting.length < majority) {
    errors.push(
      `Only ${healthyVoting.length} of ${voting.length} voting members would be healthy; a majority of ${majority} is needed to elect a primary.`
    );
  } else if (healthyVoting.length === majority && voting.length > 1) {
    warnings.push('After this change the replica set can not lose another voting member without losing its primary.');
  }
  return { errors, warnings };
}

/** Changes between two configs that `replSetReconfig` (safe reconfig, 4.4+) only allows one at a time. */
export function votingChanges(current: Document, next: Document): number {
  const before = new Map(((current.members ?? []) as ConfigMember[]).map((m) => [m._id, votesOf(m)]));
  const after = new Map(((next.members ?? []) as ConfigMember[]).map((m) => [m._id, votesOf(m)]));
  let changes = 0;
  for (const [id, votes] of after) {
    if ((before.get(id) ?? 0) !== votes) {
      changes += 1;
    }
  }
  for (const [id, votes] of before) {
    if (!after.has(id) && votes === 1) {
      changes += 1;
    }
  }
  return changes;
}

/** Merge several reports. */
export function mergeReports(...reports: SafetyReport[]): SafetyReport {
  return {
    errors: reports.flatMap((r) => r.errors),
    warnings: reports.flatMap((r) => r.warnings)
  };
}
