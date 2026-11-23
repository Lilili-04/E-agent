/** Register PDF navigation, source lookup and arithmetic in the environment preset. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const requireFromHarness = createRequire(new URL('../../../../../../apps/cli/package.json', import.meta.url))
const { defineTool } = await import(pathToFileURL(requireFromHarness.resolve('@deepseek-ai/dsh-tools')).href)
const worker = fileURLToPath(new URL('./review.py', import.meta.url))
const limits = JSON.parse(readFileSync(new URL('./limits.json', import.meta.url), 'utf8'))
const maxReportBytes = limits.mib * 1024 * 1024
const maxResultBytes = 28 * 1024
const maxPageResultBytes = 82 * 1024
const maxCachedBytes = 32 * 1024 * 1024
const maxCachedReports = 24

/** Services mounted by the environment-qa preset. */
export const inject = ['tools', 'fs']

function runWorker(python, data, args, signal, maxBuffer = maxResultBytes) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|^PYTHON/i.test(name)
  ))
  return new Promise((resolve, reject) => {
    // Isolated imports from the worker directory are added explicitly by review.py.
    const child = execFile(python, ['-I', '-X', 'utf8', '-B', worker, '-', ...args], {
      env, signal, windowsHide: true, timeout: 90000, maxBuffer, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (signal.aborted) reject(signal.reason)
      else if (error?.code === 'ENOENT') reject(new Error('找不到 Python，请安装 Python 和 PyMuPDF，或设置 DSH_EIA_PYTHON。'))
      else if (error?.killed || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Error('报告解析超时或结果超出工具限额。'))
      else if (error) reject(new Error(stderr.includes("No module named 'fitz'")
        ? '当前 Python 未安装 PyMuPDF。'
        : stderr.trim().split(/\r?\n/).at(-1) || '报告解析失败。'))
      else resolve(stdout.trim())
    })
    child.stdin?.on('error', error => {
      // Early worker exit is reported with its stderr by the process callback.
      if (error.code !== 'EPIPE' && error.code !== 'EOF' && !signal.aborted) reject(error)
    })
    child.stdin?.end(data)
  })
}

async function removeIndex(directory, path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await rmdir(directory)
}

function requireTextLength(value, limit) {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0 || value.length > limit)) {
    throw new Error(`查询项需为 1 到 ${limit} 字符的文本。`)
  }
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, result) => [{ type: 'text', text: result }],
}
const pdfPath = { type: 'string', required: true, description: '用户指定的本地 PDF 路径，或上传附件的只读路径。' }

export function apply(ctx, config = {}) {
  const reports = new Map()
  let cachedBytes = 0
  const python = config.python || 'python'
  ctx.effect(() => () => reports.clear())
  async function indexReport(filePath, execution) {
    if (!/\.pdf$/i.test(filePath)) throw new Error('请选择 PDF 文件。')
    const { signal } = execution
    const target = await ctx.fs.resolve(filePath, { cwd: execution.agent?.session.header.cwd, signal })
    const info = await ctx.fs.stat(target, signal)
    if (info?.type !== 'file') throw new Error('未找到可读取的 PDF 文件。')
    const data = await ctx.fs.readBytes(target, signal, maxReportBytes)
    const args = [`--name=${basename(filePath)}`]
    const session = execution.agent?.session.header.id
    if (!session) return await runWorker(python, data, args, signal)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-eia-'))
    const path = join(directory, 'evidence.jsonl.gz')
    try {
      const response = await runWorker(python, data, [...args, '--index-output', path], signal)
      const result = JSON.parse(response)
      if (!result.indexed_pages || result.status === 'needs_ocr') return response
      const index = await readFile(path)
      signal.throwIfAborted()
      while (reports.size >= maxCachedReports || cachedBytes + index.length > maxCachedBytes) {
        const oldest = reports.keys().next().value
        if (oldest === undefined) return response
        cachedBytes -= reports.get(oldest).index.length
        reports.delete(oldest)
      }
      const reportId = randomUUID()
      reports.set(reportId, { session, index, filename: result.file, pageCount: result.page_count })
      cachedBytes += index.length
      return JSON.stringify({ ...result, report_id: reportId })
    } finally {
      await removeIndex(directory, path)
    }
  }

  function getReport(reportId, execution) {
    const session = execution.agent?.session.header.id
    const report = reports.get(reportId)
    if (!session || report?.session !== session) {
      throw new Error('当前会话的证据索引不可用，请重新打开这份 PDF。')
    }
    return report
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'eia_report_open',
    timeoutMs: 95000,
    description: '打开环评 PDF 并索引可读原文，返回文件标题候选、目录、章节、表题及实际 PDF 页码。用 report_id 继续阅读原文。',
    parameters: { file_path: pdfPath },
    output: textOutput,
    execute({ file_path }, execution) {
      return indexReport(file_path, execution)
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'eia_report_evidence',
    timeoutMs: 35000,
    description: '读取同一会话的环评原文与表格。可按实际 PDF 页码、连续页段、主章节、表号或关键词查找。多个条件共同筛选。需要看完整上下文、续表、脚注时用 detail=page。',
    parameters: {
      report_id: { type: 'string', required: true, description: '打开报告返回的 report_id。' },
      pages: { type: 'array', items: { type: 'integer' }, description: '最多 12 个从 1 起算的实际 PDF 页码。' },
      start_page: { type: 'integer', description: '连续页段的起始页，与 end_page 一起提供。' },
      end_page: { type: 'integer', description: '连续页段的末页，包含该页。' },
      section: { type: 'string', description: '导航给出的主章节标题或其中一段文字。' },
      table: { type: 'string', description: '表号或表题，例如 表4-8。' },
      outlet: { type: 'string', description: '报告所用的排口编号，例如 DW001。' },
      pollutant: { type: 'string', description: '污染物名称，例如 总氮、TN 或非甲烷总烃。' },
      keywords: { type: 'array', items: { type: 'string' }, description: '最多 4 个原文关键词，全部必须匹配。' },
      detail: { type: 'string', enum: ['excerpt', 'page'], description: 'excerpt 返回命中片段（默认），page 返回可提取的整页文字及更多表格行。' },
      row_start: { type: 'integer', description: '可选。读取匹配表格时，从此表内行号继续。默认从第 1 行开始。' },
      limit: { type: 'integer', description: '每批返回页数，默认 4，最多 12。页段可使用 next_start_page 继续读。' },
    },
    output: textOutput,
    async execute({ report_id, pages = [], start_page, end_page, section, table, outlet, pollutant,
      keywords = [], detail = 'excerpt', row_start = 1, limit = 4 }, execution) {
      const report = getReport(report_id, execution)
      const validPage = page => Number.isInteger(page) && page >= 1 && page <= report.pageCount
      const range = start_page !== undefined || end_page !== undefined
      if (range && (pages.length || !validPage(start_page) || !validPage(end_page) || start_page > end_page)) {
        throw new Error('请给出报告内有效且顺序正确的一对页段起止页，或给出离散页码。')
      }
      requireTextLength(section, 100)
      requireTextLength(table, 100)
      requireTextLength(outlet, 32)
      requireTextLength(pollutant, 48)
      if (pages.length > 12 || pages.some(page => !validPage(page))
          || keywords.length > 4 || !Number.isInteger(limit) || limit < 1 || limit > 12
          || !Number.isSafeInteger(row_start) || row_start < 1) {
        throw new Error('请检查 PDF 页码、关键词数量、返回页数和表内行号。')
      }
      for (const keyword of keywords) requireTextLength(keyword, 65)
      const query = {
        pages: [...new Set(pages)], start_page, end_page, section, table, outlet, pollutant,
        keywords, detail, row_start, limit,
      }
      const result = JSON.parse(await runWorker(python, report.index,
        [`--evidence-query=${JSON.stringify(query)}`], execution.signal,
        detail === 'page' ? maxPageResultBytes : maxResultBytes))
      if (reports.get(report_id) === report) {
        reports.delete(report_id)
        reports.set(report_id, report)
      }
      return JSON.stringify({ ...result, file: report.filename, report_id })
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'eia_calculate',
    timeoutMs: 15000,
    description: '按你给出的算式和变量做十进制复算。支持 + - * /、括号、有限整数幂 **、abs、sqrt、ln、log10、min、max、sum。运算使用 28 位有效数字，返回结果和所用变量。',
    parameters: {
      report_id: { type: 'string', description: '可选。变量来自同一份已打开的报告时，绑定该报告。' },
      variables: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', required: true, description: '算式中的变量名，以英文字母开头。' },
        value: { type: 'string', required: true, description: '十进制字符串，例如 0.7；百分数先按算式口径转换。' },
        unit: { type: 'string', description: '报告数值的单位，或填写按算式换算后的单位。' },
        page: { type: 'integer', description: '来源的实际 PDF 页码。' },
        source: { type: 'string', description: '原文表号、字段、引文或假设。' },
      } } },
      formulas: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        label: { type: 'string', required: true, description: '这个结果代表什么。' },
        expression: { type: 'string', required: true, description: '使用半角数字、运算符、括号和英文字母变量名。' },
        unit: { type: 'string', description: '结果单位。' },
      } } },
    },
    output: textOutput,
    async execute({ report_id, variables = [], formulas }, execution) {
      const report = report_id === undefined ? undefined : getReport(report_id, execution)
      if (report && variables.some(item => item.page > report.pageCount)) throw new Error('变量来源超出了报告页数。')
      const data = Buffer.from(JSON.stringify({ variables, formulas }))
      if (data.length > 32 * 1024) throw new Error('算式和变量来源过长，请缩短或分批。')
      const response = await runWorker(python, data, ['--calculate'], execution.signal)
      return report ? JSON.stringify({ ...JSON.parse(response), report_id, file: report.filename }) : response
    },
  })))
}
