import { resolve, relative } from 'path'

/**
 * Assert that a resolved path is within the allowed root directory.
 * Prevents path traversal attacks (e.g., "../../etc/passwd").
 * Returns the resolved absolute path if valid, throws otherwise.
 */
export function assertWithinRoot(filePath: string, root: string = process.cwd()): string {
  const resolved = resolve(filePath)
  const resolvedRoot = resolve(root)
  const rel = relative(resolvedRoot, resolved)

  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(`Path "${filePath}" is outside allowed root "${resolvedRoot}"`)
  }

  return resolved
}
