/**
 * Convert a model supplied path into a safe, logical path relative to a
 * workspace root. The model never receives or controls a native URI.
 */
export function normalizeWorkspacePath(input: string | undefined, allowRoot = true): string {
  const raw = (input ?? '.').trim()

  if (!raw) {
    if (allowRoot) return '.'
    throw new Error('A file path is required.')
  }

  if (raw.includes('\0')) {
    throw new Error('Path contains a NUL byte.')
  }

  // Reject URI schemes and absolute paths before normalizing separators.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) || raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error('Only paths relative to the active workspace are allowed.')
  }

  const normalizedSeparators = raw.replaceAll('\\', '/')
  const segments = normalizedSeparators.split('/')
  const safeSegments: string[] = []

  for (const originalSegment of segments) {
    const segment = originalSegment.normalize('NFC')
    if (!segment || segment === '.') continue
    if (segment === '..') {
      throw new Error('Path traversal outside the active workspace is not allowed.')
    }
    if ([...segment].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
      throw new Error('Path contains a control character.')
    }
    safeSegments.push(segment)
  }

  if (safeSegments.length === 0) {
    if (allowRoot) return '.'
    throw new Error('A file path is required.')
  }

  return safeSegments.join('/')
}

export function splitWorkspacePath(input: string | undefined, allowRoot = true): string[] {
  const normalized = normalizeWorkspacePath(input, allowRoot)
  return normalized === '.' ? [] : normalized.split('/')
}

export function isHiddenWorkspaceName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..'
}

export function assertWorkspacePathNotReserved(path: string): void {
  const firstSegment = splitWorkspacePath(path)[0]
  if (firstSegment === '.cherry-agent-trash' || firstSegment === '.cherry-agent-tmp') {
    throw new Error('Agent internal paths are not directly accessible.')
  }
}
