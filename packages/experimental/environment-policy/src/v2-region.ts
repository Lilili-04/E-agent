/** Province attribution filters never establish city or county applicability. */
import { canonical, type DocumentCard } from './v2-database.ts'

/** Resolve explicit province aliases; unscoped questions use national evidence.
 * @param question - Original question.
 * @param documents - Available file metadata.
 * @param _exact - Retained caller argument; document matches never infer a region.
 * @param region - Optional explicit catalog province.
 * @param mode - Include national evidence, or use only the selected province.
 * @returns Allowed catalog province names.
 */
export function policyRegions(question: string, documents: DocumentCard[], _exact: DocumentCard[],
  region?: string, mode: 'applicable' | 'only' = 'applicable'): string[] {
  const names = [...new Set(['全国', ...documents.flatMap(doc => doc.region ? [doc.region] : [])])]
  const aliases = (name: string) => name === '全国' ? ['全国', '国家级']
    : [name, name.replace(/(?:壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/u, '')]
  let selected: string[]
  if (region) {
    selected = names.filter(name => aliases(name).some(alias => canonical(alias) === canonical(region)))
    if (!selected.length) throw new Error('Unknown region; use a province name present in the policy collection')
  } else {
    const normalized = canonical(question)
    selected = names.filter(name => name !== '全国' && aliases(name).some(alias => normalized.includes(canonical(alias))))
    if (!selected.length) selected = ['全国']
  }
  const only = mode === 'only' || /仅(?:查|检索|找|限|看|根据|依据)|只(?:查|检索|找|看|根据|依据)|地方出台|地方发布/u.test(question)
  return [...new Set(only ? selected : [...selected, '全国'])]
}
