/** Step9 deterministic retrieval evaluation cases. Keep expected titles human-readable; the runner resolves record keys from the fixed index. */
export interface EnvironmentPolicyEvaluationCase {
  readonly id: string
  readonly category: 'article' | 'topic' | 'date' | 'status' | 'history' | 'no-answer' | 'negative' | 'ocr'
  readonly question: string
  readonly expectedDocumentTitles: readonly string[]
  readonly expectResults: boolean
}

const documents = [
  '城市绿化条例', '中华人民共和国海洋环境保护法', '中华人民共和国水污染防治法',
  '中华人民共和国固体废物污染环境防治法', '中华人民共和国大气污染防治法', '中华人民共和国环境保护法',
  '中华人民共和国环境保护税法', '排污许可管理条例', '城镇排水与污水处理条例', '畜禽规模养殖污染防治条例',
  '防治船舶污染海洋环境管理条例', '“十四五”海洋生态环境保护规划', '“十四五”塑料污染治理行动方案',
  '“十四五”噪声污染防治行动计划', '“十四五”土壤、地下水和农村生态环境保护规划', '工业绿色发展规划（2016—2020年）',
  '“十四五”生态环境监测规划', '“十四五”生态保护监管规划', '生活垃圾焚烧污染控制标准', '地表水环境质量标准',
] as const

const cases: EnvironmentPolicyEvaluationCase[] = []
for (const [index, title] of documents.entries()) {
  const id = String(index + 1).padStart(2, '0')
  cases.push(
    { id: `article-${id}`, category: 'article', question: `《${title}》第一条主要规定什么？`, expectedDocumentTitles: [title], expectResults: true },
    { id: `topic-${id}`, category: 'topic', question: `${title}主要解决什么环境管理问题？`, expectedDocumentTitles: [title], expectResults: true },
    { id: `date-${id}`, category: 'date', question: `${title}的发布日期是什么？`, expectedDocumentTitles: [title], expectResults: true },
    { id: `status-${id}`, category: 'status', question: `${title}目前标注的效力状态是什么？`, expectedDocumentTitles: [title], expectResults: true },
  )
}

cases.push(
  { id: 'history-01', category: 'history', question: '《城市绿化条例》历次修订有哪些版本？', expectedDocumentTitles: ['城市绿化条例'], expectResults: true },
  { id: 'history-02', category: 'history', question: '防治船舶污染海洋环境管理条例有哪些历史版本？', expectedDocumentTitles: ['防治船舶污染海洋环境管理条例'], expectResults: true },
  { id: 'history-03', category: 'history', question: '请比较城市绿化条例的不同版本。', expectedDocumentTitles: ['城市绿化条例'], expectResults: true },
  { id: 'no-answer-01', category: 'no-answer', question: '国家级资料中有没有关于火星环境治理的法规？', expectedDocumentTitles: [], expectResults: false },
  { id: 'no-answer-02', category: 'no-answer', question: '请查找本地语料中关于虚构行星排污许可的规定。', expectedDocumentTitles: [], expectResults: false },
  { id: 'negative-01', category: 'negative', question: '哪些国家级文件明确不涉及海洋环境保护？', expectedDocumentTitles: [], expectResults: false },
  { id: 'negative-02', category: 'negative', question: '《中华人民共和国海洋环境保护法》是否规定了火星大气排放限值？', expectedDocumentTitles: ['中华人民共和国海洋环境保护法'], expectResults: true },
  { id: 'ocr-01', category: 'ocr', question: '检索工业污染防治技术指南中关于污染控制的原文。', expectedDocumentTitles: ['氮肥工业污染防治可行技术指南 （HJ 1302—2023）'], expectResults: true },
  { id: 'ocr-02', category: 'ocr', question: '检索海洋环境保护相关文件中的生态保护要求。', expectedDocumentTitles: ['中华人民共和国海洋环境保护法', '“十四五”海洋生态环境保护规划'], expectResults: true },
  { id: 'topic-21', category: 'topic', question: '国家级资料中哪些文件涉及城市污水和排水管理？', expectedDocumentTitles: ['城镇排水与污水处理条例'], expectResults: true },
)

/** The initial Step9 set contains 90 deterministic cases across eight categories. */
export const ENVIRONMENT_POLICY_EVALUATION_CASES: readonly EnvironmentPolicyEvaluationCase[] = cases

if (ENVIRONMENT_POLICY_EVALUATION_CASES.length !== 90) {
  throw new Error(`environment-policy evaluation set must contain 90 cases, got ${ENVIRONMENT_POLICY_EVALUATION_CASES.length}`)
}
