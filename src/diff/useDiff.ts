// React hook around the diff service.
//
// Keeps the component subscribed to the diff cache + registry, and
// transparently triggers (and awaits) a build when the (A,B) pair — or the
// current registry snapshot — changes. Returns a small discriminated union
// so UI can show a loader / error / idle.

import { useEffect, useRef, useState } from 'react';
import { getOrComputeDiff, peekDiff, subscribeDiff } from './service';
import type { DiffResult } from './engine';
import { getRegistry, subscribeRegistry } from '../registry/registry';

export type DiffStatus =
  | { kind: 'idle' }
  | { kind: 'no-registry' }
  | { kind: 'loading'; feedA: string; feedB: string }
  | { kind: 'ready'; feedA: string; feedB: string; result: DiffResult }
  | { kind: 'error'; feedA: string; feedB: string; message: string };

/**
 * @param feedA The "before" feed id, or null/empty to stay idle.
 * @param feedB The "after" feed id, or null/empty.
 */
export function useDiff(feedA: string | null, feedB: string | null): DiffStatus {
  // `registryBuiltAt` in state is what ties this component to a specific
  // registry snapshot — when it bumps (registry rebuild) we force the
  // compute effect to re-run against the new snapshot instead of sitting
  // on a pre-invalidation `loading` state forever.
  const [registryBuiltAt, setRegistryBuiltAt] = useState<number | null>(
    () => getRegistry()?.builtAt ?? null,
  );
  const [status, setStatus] = useState<DiffStatus>(() => initial(feedA, feedB));
  const reqRef = useRef(0);

  // Re-render on service or registry changes.
  useEffect(() => {
    const tickService = () => setStatus((s) => refreshFromCache(s, feedA, feedB));
    const tickRegistry = () => {
      const cur = getRegistry()?.builtAt ?? null;
      setRegistryBuiltAt(cur);
      setStatus((s) => refreshFromCache(s, feedA, feedB));
    };
    const u1 = subscribeDiff(tickService);
    const u2 = subscribeRegistry(tickRegistry);
    return () => { u1(); u2(); };
  }, [feedA, feedB]);

  // Kick off a compute when inputs OR the active registry snapshot change.
  useEffect(() => {
    if (!feedA || !feedB || feedA === feedB) {
      setStatus({ kind: 'idle' });
      return;
    }
    if (!getRegistry()) {
      setStatus({ kind: 'no-registry' });
      return;
    }
    const cached = peekDiff(feedA, feedB);
    if (cached) {
      setStatus({ kind: 'ready', feedA, feedB, result: cached });
      return;
    }
    reqRef.current += 1;
    const myReq = reqRef.current;
    setStatus({ kind: 'loading', feedA, feedB });
    getOrComputeDiff(feedA, feedB)
      .then((result) => {
        if (myReq !== reqRef.current) return;
        setStatus({ kind: 'ready', feedA, feedB, result });
      })
      .catch((err) => {
        if (myReq !== reqRef.current) return;
        setStatus({
          kind: 'error',
          feedA,
          feedB,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [feedA, feedB, registryBuiltAt]);

  return status;
}

function initial(feedA: string | null, feedB: string | null): DiffStatus {
  if (!feedA || !feedB || feedA === feedB) return { kind: 'idle' };
  if (!getRegistry()) return { kind: 'no-registry' };
  const cached = peekDiff(feedA, feedB);
  if (cached) return { kind: 'ready', feedA, feedB, result: cached };
  return { kind: 'loading', feedA, feedB };
}

function refreshFromCache(
  prev: DiffStatus,
  feedA: string | null,
  feedB: string | null,
): DiffStatus {
  if (!feedA || !feedB || feedA === feedB) return { kind: 'idle' };
  if (!getRegistry()) return { kind: 'no-registry' };
  const cached = peekDiff(feedA, feedB);
  if (cached) return { kind: 'ready', feedA, feedB, result: cached };
  // Keep the current loading/error so we don't flap.
  if (prev.kind === 'loading' || prev.kind === 'error') return prev;
  return { kind: 'loading', feedA, feedB };
}
