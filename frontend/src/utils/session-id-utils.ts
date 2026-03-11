/**
 * Session ID utilities for parent-linked UUIDs with chain/fork discrimination.
 * Frontend mirror — pure functions, no Node dependencies.
 *
 * Session ID schema:
 *   {last 16 hex of parent}{discriminator}{random 15 hex} = 32 hex, formatted as UUID
 *
 * Discriminator at hex position 16:
 *   'c' = chain link (continuation session, replaces compaction)
 *   'f' = fork (branched session)
 */

export type LinkType = 'chain' | 'fork';

/**
 * Strip any prefix (agent_, sess_) and dashes to get raw hex from a session ID.
 */
export function toRawHex(sessionId: string): string {
  return sessionId.replace(/^(agent_|sess_)/, '').replace(/-/g, '');
}

/**
 * Parse the link type from a session ID by inspecting the discriminator at hex position 16.
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
 * Returns all chain-linked session IDs in order from oldest to newest.
 * Only follows 'chain' links (discriminator 'c').
 */
export function walkChain(sessionId: string, allSessionIds: string[]): string[] {
  const last16Map = new Map<string, string>();
  for (const id of allSessionIds) {
    const hex = toRawHex(id);
    if (hex.length >= 16) {
      last16Map.set(hex.slice(-16), id);
    }
  }

  const chain: string[] = [sessionId];
  let current = sessionId;

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
