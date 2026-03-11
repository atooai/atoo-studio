/**
 * Session ID utilities for parent-linked UUIDs with chain/fork discrimination.
 *
 * Session ID schema:
 *   {last 16 hex of parent}{discriminator}{random 15 hex} = 32 hex, formatted as UUID
 *
 * Discriminator at hex position 16:
 *   'c' = chain link (continuation session, replaces compaction)
 *   'f' = fork (branched session)
 *
 * Root sessions (no parent) have no discriminator — they're standard UUIDs.
 */
import crypto from 'crypto';

export type LinkType = 'chain' | 'fork';

const DISCRIMINATOR: Record<LinkType, string> = {
  chain: 'c',
  fork: 'f',
};

/**
 * Strip any prefix (agent_, sess_) and dashes to get raw hex from a session ID.
 */
export function toRawHex(sessionId: string): string {
  return sessionId.replace(/^(agent_|sess_)/, '').replace(/-/g, '');
}

/**
 * Format 32 hex chars as a UUID string (8-4-4-4-12).
 */
function formatAsUuid(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Generate a parent-linked UUID with a chain/fork discriminator.
 *
 * Layout: {parent's last 16 hex}{c|f}{random 15 hex} = 32 hex total
 *
 * @param parentSessionId - The parent session ID (any format: agent_xxx, sess_xxx, bare UUID)
 * @param linkType - 'chain' for continuation sessions, 'fork' for branched sessions
 * @returns A UUID-formatted string with embedded parent link and discriminator
 */
export function buildLinkedUuid(parentSessionId: string, linkType: LinkType): string {
  const parentRaw = toRawHex(parentSessionId);
  const last16 = parentRaw.slice(-16);
  const disc = DISCRIMINATOR[linkType];
  const randomHex = crypto.randomBytes(8).toString('hex').slice(0, 15); // 15 hex chars
  const newHex = last16 + disc + randomHex;

  return formatAsUuid(newHex);
}

/**
 * Parse the link type from a session ID by inspecting the discriminator at hex position 16.
 *
 * @returns 'chain', 'fork', or null if no discriminator is present (root/old-format session)
 */
export function parseLinkType(sessionId: string): LinkType | null {
  const hex = toRawHex(sessionId);
  if (hex.length < 32) return null;

  const disc = hex[16];
  if (disc === 'c') return 'chain';
  if (disc === 'f') return 'fork';
  return null;
}

/**
 * Get the parent link portion (first 16 hex chars) from a session ID.
 * This corresponds to the parent's last 16 hex chars.
 */
export function getParentLink(sessionId: string): string {
  return toRawHex(sessionId).slice(0, 16);
}

/**
 * Walk a session chain backward from a starting session ID.
 * Returns all chain-linked session IDs in order from oldest to newest (starting session last).
 *
 * Only follows 'chain' links (discriminator 'c'). Fork links are ignored.
 *
 * @param sessionId - The session to start walking from
 * @param allSessionIds - All known session IDs to search through
 * @returns Array of session IDs forming the chain, oldest first
 */
export function walkChain(sessionId: string, allSessionIds: string[]): string[] {
  // Build lookup: last16 hex → session ID
  const last16Map = new Map<string, string>();
  for (const id of allSessionIds) {
    const hex = toRawHex(id);
    if (hex.length >= 16) {
      last16Map.set(hex.slice(-16), id);
    }
  }

  const chain: string[] = [sessionId];
  let current = sessionId;

  // Walk backward: current's first16 = parent's last16, but only if it's a chain link
  while (true) {
    const linkType = parseLinkType(current);
    if (linkType !== 'chain') break;

    const parentLink = getParentLink(current);
    const parentId = last16Map.get(parentLink);
    if (!parentId || parentId === current || chain.includes(parentId)) break;

    chain.unshift(parentId);
    current = parentId;
  }

  return chain;
}
