/**
 * Create a child AbortController linked to a parent signal.
 * Parent abort propagates down; child abort does NOT propagate up.
 * Pattern from Claude Code's forkedAgent.ts.
 */
export function createChildAbort(parent?: AbortSignal): AbortController {
  const child = new AbortController()

  if (parent) {
    if (parent.aborted) {
      child.abort(parent.reason)
    } else {
      parent.addEventListener('abort', () => child.abort(parent.reason), {
        once: true,
        signal: child.signal, // auto-cleanup if child aborts first
      })
    }
  }

  return child
}

/**
 * Create a sibling AbortController — aborting the sibling does NOT abort the parent
 * but DOES cancel concurrent work. Pattern from Claude Code's StreamingToolExecutor.
 */
export function createSiblingAbort(parent?: AbortSignal): AbortController {
  return createChildAbort(parent)
}
