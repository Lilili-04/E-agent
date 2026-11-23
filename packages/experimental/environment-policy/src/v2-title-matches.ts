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

/** Resolve a shortened legal title only when one complete title remains possible.
 * @param question - Canonical query.
 * @param titles - Canonical scoped legal titles.
 * @returns Unique full title, or no resolution when absent or ambiguous.
 */
export function resolvePolicyShortTitle(question: string, titles: readonly string[]): string | undefined {
  const phrase = question.replace(/^.*?[《]/u, '').replace(/》.*$/u, '')
    .replace(/^(?:请问|请查询|查询|现在|目前|当前)+/u, '')
    .replace(/(?:现行|现在|目前|当前|是否|是不是|还|仍|已|被|有效|废止|失效|截至|截止|在\d{4}).*$/u, '')
    .replace(/[？?。，,！!]/gu, '').replace(/^中华人民共和国/u, '')
  if (phrase.length < 4 || !/(?:法|条例|办法|规定)$/u.test(phrase)) return undefined
  if (titles.some(title => title.replace(/^中华人民共和国/u, '') === phrase)) return undefined
  const matches = [...new Set(titles)].filter((title) => {
    const name = title.replace(/^中华人民共和国/u, '')
    if (!name.endsWith(phrase.match(/(?:条例|办法|规定|法)$/u)?.[0] ?? '') || phrase.length >= name.length) return false
    let position = 0
    for (const character of name) if (character === phrase[position]) position++
    return position === phrase.length
  })
  return matches.length === 1 ? matches[0] : undefined
}
