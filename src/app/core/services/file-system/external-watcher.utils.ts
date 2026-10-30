// ───────────── event classification ─────────────

import { WorkspaceNode } from '../../store/workspace/workspace.state';

export type WatchAction = 'create' | 'remove' | 'modify' | 'rename' | 'ignore';

export interface ClassifiedWatchEvent {
  action: WatchAction;
  /** For create/remove: 'file' | 'folder' | 'any' | 'other' (Windows often reports 'any'). */
  entry?: string;
  /** For rename: 'both' | 'from' | 'to' | 'any' | 'other'. */
  mode?: string;
}

/**
 * tauri-plugin-fs `WatchEvent.type` is either a plain string ('any' | 'other')
 * or a one-key object: { create: {kind} } | { remove: {kind} } | { modify: {kind, mode?} } | { access: ... }
 */
export function classifyWatchEvent(type: unknown): ClassifiedWatchEvent {
  if (!type || typeof type !== 'object') return { action: 'ignore' };
  const [key, detail] = Object.entries(type as Record<string, any>)[0] ?? [];

  switch (key) {
    case 'create':
      return { action: 'create', entry: detail?.kind };
    case 'remove':
      return { action: 'remove', entry: detail?.kind };
    case 'modify':
      if (detail?.kind === 'rename') return { action: 'rename', mode: detail.mode };
      if (detail?.kind === 'metadata') return { action: 'ignore' }; // timestamps/permissions only
      return { action: 'modify' }; // 'data' | 'any' | 'other'
    default:
      return { action: 'ignore' }; // access events etc.
  }
}

// ───────────── paths ─────────────
// The store mixes '/' and '\\' (e.g. submitInlineCreation builds "parent/name"),
// so every comparison goes through normalizePath.

export const normalizePath = (p: string): string => p.replace(/\//g, '\\');

export const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b);

export function parentPathOf(path: string): string {
  const n = normalizePath(path);
  return n.substring(0, n.lastIndexOf('\\'));
}

export function baseNameOf(path: string): string {
  const n = normalizePath(path);
  return n.substring(n.lastIndexOf('\\') + 1);
}

/** 'Makefile' -> '' (not 'Makefile'), 'a.b.ts' -> 'ts' */
export function extensionOf(name: string): string {
  return name.includes('.') ? (name.split('.').pop() as string) : '';
}

// ───────────── tree ─────────────

export function findNodeByPath(
  nodes: Record<string, WorkspaceNode>,
  path: string,
): WorkspaceNode | undefined {
  const target = normalizePath(path);
  return Object.values(nodes).find((n) => normalizePath(n.path) === target);
}

/** The node itself plus every loaded descendant, walked through `children` (no path-prefix guessing). */
export function collectSubtreeIds(nodes: Record<string, WorkspaceNode>, rootId: string): string[] {
  const ids: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    const node = nodes[id];
    if (!node) continue;
    ids.push(id);
    if ('children' in node && node.children) stack.push(...node.children);
  }
  return ids;
}

// ───────────── text ─────────────

/**
 * Smallest single edit that turns `prev` into `next` (common prefix/suffix trimmed).
 * Applying only that edit keeps the cursor, scroll position and undo history of an open editor,
 * which replacing the whole document would not.
 */
export function computeMinimalEdit(
  prev: string,
  next: string,
): { start: number; endPrev: number; text: string } {
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;

  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev--;
    endNext--;
  }
  return { start, endPrev, text: next.slice(start, endNext) };
}
export function sortRecordByName<T extends { name: string }>(
  rec: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(rec).sort(([, a], [, b]) => a.name.localeCompare(b.name)),
  );
}

/** Child ids ordered by the name of the node each one points to. */
export function sortIdsByName(ids: string[], nodes: Record<string, { name: string }>): string[] {
  return [...ids].sort((a, b) => nodes[a].name.localeCompare(nodes[b].name));
}
