/** Retain independently named files while excluding names embedded in longer titles.
 * @param question - Canonical query text.
 * @param entries - Available documents or identities.
 * @param names - Canonical title aliases for each entry.
 * @returns Entries with at least one independent title occurrence.
 */
export function policyTitleMatches<T>(question: string, entries: readonly T[], names: (entry: T) => string[]): T[] {
  const spans = entries.flatMap(entry => names(entry).flatMap((name) => {
    if (name.length < 4) return []
    const matches: { entry: T; start: number; end: number }[] = []
    let start = question.indexOf(name)
    while (start >= 0) {
      matches.push({ entry, start, end: start + name.length })
      start = question.indexOf(name, start + 1)
    }
    return matches
  }))
  return [...new Set(spans.filter(span => !spans.some(other => other.start <= span.start && other.end >= span.end &&
    (other.start < span.start || other.end > span.end))).map(span => span.entry))]
}
