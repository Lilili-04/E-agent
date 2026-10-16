/** Set a new browser workspace to the authenticated same-origin Chroma gateway. */
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) throw new Error('prepare-ui: provide the upstream App.vue path')
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
    <strong>DGX 只读浏览 / Read-only</strong>
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
writeFileSync(path, source)
