/** Set a new browser workspace to the same-origin read-only Chroma gateway. */
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) throw new Error('prepare-ui: provide the upstream App.vue path')
const scope = process.argv[3] ?? 'dgx'
if (!['dgx', 'local'].includes(scope)) throw new Error('prepare-ui: scope must be dgx or local')
const label = scope === 'local' ? '本地' : 'DGX'
let source = readFileSync(path, 'utf8')
for (const [before, after] of [
  ['const url = ref("http://localhost:8080");', 'const url = ref(window.location.origin);'],
  ['const queryMode = ref("semantic");', 'const queryMode = ref("embedding");'],
  ['await axios.get(`${url.value}/api/v2`);', 'await axios.get(`${url.value}/api/v2/heartbeat`);'],
  ['await axios.get(apiUrl.value, {', 'await axios.get(`${apiUrl.value}/heartbeat`, {'],
  ['const currentCollectionData = ref([]);', 'const currentCollectionData = ref([]);\nconst viewerOffset = ref(0);'],
  ['const handleCollectionSelection = async (collection, isUpdating = false) => {', 'const handleCollectionSelection = async (collection, isUpdating = false, nextOffset = 0) => {'],
  ['currentCollection.value = collection;\n  currentCollectionData.value = [];', 'viewerOffset.value = nextOffset;\n  currentCollection.value = collection;\n  currentCollectionData.value = [];'],
  ['include: ["documents", "metadatas"],\n      },', 'include: ["documents", "metadatas"],\n        limit: 500,\n        offset: viewerOffset.value,\n      },'],
  ['<template>\n  <Toast />', `<template>
  <Toast />
  <div style="padding:12px;background:#fff3cd;color:#413600;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <strong>${label} 只读浏览 / Read-only</strong>
    <span>每批最多 500 条；表格筛选仅作用于当前批次。Filters apply to the loaded batch.</span>
    <template v-if="currentCollection">
      <span>批次 / Batch {{ Math.floor(viewerOffset / 500) + 1 }}</span>
      <button type="button" :disabled="isFetchingCollectionData || viewerOffset === 0" @click="handleCollectionSelection(currentCollection, true, Math.max(0, viewerOffset - 500))">上一批 / Previous</button>
      <button type="button" :disabled="isFetchingCollectionData || currentCollectionData.length < 500" @click="handleCollectionSelection(currentCollection, true, viewerOffset + 500)">下一批 / Next</button>
    </template>
  </div>`],
]) {
  if (source.split(before).length !== 2) throw new Error(`prepare-ui: upstream marker changed: ${before}`)
  source = source.replace(before, after)
}
if (scope === 'local') {
  let vectorEditButtons = 0
  source = source.replace(/<button\b[^>]*@click="startEmbeddingEdit\([^"]*"[^>]*>/g, (button) => {
    vectorEditButtons++
    return button.replace('<button', '<button v-if="false"')
  })
  if (vectorEditButtons !== 2) throw new Error('prepare-ui: vector edit button markers changed')
  for (const [before, after] of [
    ['edit embeddings', 'inspect stored vectors'],
    ['Import JSON records', 'Inspect policy metadata'],
    ['Paste JSON, then add or upsert records into the active collection.', 'Review document IDs, regions, source hashes, and passage offsets.'],
    ['Edit data in place', 'Inspect stored vectors'],
    ['Update documents, metadata, and embeddings directly inside the dashboard.', 'Preview stored vectors and their dimensions without changing records.'],
    ['clean up metadata', 'review metadata'],
    ['Search and edit the current records', 'Search the current records'],
  ]) source = source.replace(before, after)
  source += `\n<style>\n.sidebar-actions .ui-button--primary, .collection-card__menu,
.workspace-import-cta, .workspace-activity-cta, .table-bulk-strip,
.table-toolbar__actions .ui-button--primary, .cell-document__action,
.cell-json__action, .row-action--danger { display: none !important; }
</style>\n`
}
writeFileSync(path, source)
