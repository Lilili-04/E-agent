/** Shared Chinese segmentation for FTS5 imports and queries. */
import { cut, add_word } from 'jieba-wasm'

const policyWords = [
  '水土保持', '水污染', '大气污染', '固体废物', '危险废物', '生态环境',
  '排污许可证', '环境影响评价', '饮用水', '畜禽养殖', '放射性污染',
  '水土流失', '核安全', '排污许可', '地下水', '排放标准', '污染防治',
]
for (const word of policyWords) add_word(word, 100_000)
const stopWords = new Set(['的', '了', '吗', '呢', '什么', '怎么', '如何', '哪些', '讲', '一下', '请问', '是否', '可以'])
const questionWords = new Set(['能', '要', '有', '中', '是', '需要', '手续', '要求', '规定', '相关', '法规', '法律', '政策', '文件', '管理'])
// Retrieval expansion is explicit and query-only; source tokens and negations remain unchanged.
const queryAliases: Record<string, string[]> = {
  养殖场: ['畜禽养殖'], 河里: ['河道', '水体'], 排到: ['排入'], 废水: ['污水'],
  排污许可证: ['排污许可'],
}

/** Segment text without inventing bigrams; repeated terms retain BM25 term frequency.
 * @param text - Original source or query.
 * @returns Jieba terms including negations, numbers and technical units.
 */
export function policyTerms(text: string): string[] {
  return cut(text.normalize('NFKC').toLowerCase(), true)
    .map(word => word.trim())
    .filter(word => /[\p{L}\p{N}]/u.test(word) && !stopWords.has(word))
}

/** Produce a literal FTS5 OR expression, never accepting query operators from model input.
 * @param text - User query.
 * @returns Safe MATCH expression, or undefined for an empty query.
 */
export function policyMatch(text: string): string | undefined {
  const terms = policyTerms(text).filter(word => !questionWords.has(word))
  const words = [...new Set(terms.flatMap(word => [word, ...(queryAliases[word] ?? [])]))]
  return words.length ? words.map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ') : undefined
}
