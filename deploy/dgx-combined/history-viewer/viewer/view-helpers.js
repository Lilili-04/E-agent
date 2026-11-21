'use strict';
// Compact provenance and date presentation shared by timeline, graph and metadata.
function correctedProfile(){return document.getElementById('graph-source').value==='corrected';}
function reviewedProfile(){return ['historical','corrected','reviewed'].includes(document.getElementById('graph-source').value);}
function compareVersions(a,b){const x=versionDate(a),y=versionDate(b);return x&&y?y.localeCompare(x):x?-1:y?1:(a.version_label||a.title).localeCompare(b.version_label||b.title,'zh-CN');}
function versionLabel(v){return v.version_label||versionDate(v)||'日期待核实';}
function sourceStatus(v){return ({partial:'原资料标记为部分正文 · 目标正文完整性待单独核查',complete:'原资料标记完整 · 目标正文未单独核查',history_only:'仅有沿革记载 · 暂无本版独立正文',bundled_attachment:'正文随印发通知附件保存 · 未另建SQLite来源记录'})[v.source_text_status]||(v.document_ids?.length?'有正文来源 · 完整性未展示':'仅有沿革记载 · 暂无本版独立正文');}
function proofRefs(n){return (n.evidence_refs||[]).map(r=>typeof r==='string'?JSON.parse(r):r);}
function renderSourceEvidence(source,refs){
 const body=detailRoot(),lines=source.full_text.split(/\r?\n/);
 const ranges=[...new Map(refs.filter(r=>r.line_start&&r.line_end).map(r=>[`${r.line_start}-${r.line_end}`,r])).values()];
 if(ranges.length){
  body.append(el('p','note','以下按记录中的行号定位；高亮是所登记证据范围。'));
  for(const r of ranges.slice(0,12)){
   body.append(el('p','note',`原文第 ${r.line_start}—${r.line_end} 行`));
   const quote=el('blockquote','located-source');
   for(let i=Math.max(1,r.line_start-1);i<=Math.min(lines.length,r.line_end+1,r.line_start+119);i++){
    const line=el(i>=r.line_start&&i<=r.line_end?'mark':'span','source-line',`${i}  ${lines[i-1]}\n`);quote.append(line);
   }
   if(r.line_end-r.line_start>=120)quote.append(el('span','note','定位范围较长，仅预览前120行；完整原文见下方。'));
   body.append(quote);
  }
  if(ranges.length>12)body.append(el('p','note','定位范围超过12处，剩余范围可在完整原文核对。'));
 }
 const full=el('details','disclosure');full.append(el('summary','','展开完整原文'),el('blockquote','',source.full_text));body.append(full);
}
function showSourceButtons(refs,back,label='读取原文'){
 const ids=[...new Set((refs||[]).map(r=>r.document_id))];
 ids.forEach((id,i)=>detailRoot().append(button(label+(ids.length>1?' '+(i+1):''),async()=>{
  try{const response=await fetch('/api/source?id='+encodeURIComponent(id)),source=await response.json();if(!response.ok)throw Error(source.error);
   dialog(source.title);detailRoot().append(button('← 返回记录',back,'text-button back-button'));field('来源文档',id);
   renderSourceEvidence(source,refs.filter(r=>r.document_id===id));
  }catch(error){field('读取失败',error.message);}
 },'source-button')));
}
function renderNodeMetadata(n){
 dialog(n.title);field('记录类型',n.kind==='Regulation'?'法规／文件':'法规版本');reviewFields(n);
 detailRoot().append(el('p','note','审查状态说明已有事实的核对情况；不代表日期、正文或现行效力已全部确定。'));
 if(n.kind==='Regulation'){field('地区',n.region);field('别名',(n.aliases||[]).join('、')||'未记录');return;}
 if(n.version_label)field('原文版次标识',n.version_label);
 if(n.adoption_date)field('本文本通过日期',n.adoption_date);
 field(document.getElementById('graph-source').value==='rule'?'沿革日期（旧参考）':'公布日期',n.publish_date);field('修订／修正日期',n.revision_date||'未记载');field('本版本施行日期',n.effective_date);
 field('发布机关',n.issuer);field('文号',n.document_number);field('文件类型',n.document_type);field('资料完整性',sourceStatus(n));
 if(n.status_note)field('来源所载状态及版本说明（非当前效力判定）',n.status_note);
 const refs=proofRefs(n);
 if(n.identity_evidence){const proof=el('details','disclosure');proof.append(el('summary','','查看版本身份依据'),el('blockquote','',n.identity_evidence));detailRoot().append(proof);}
 showSourceButtons((n.document_ids||[]).map(id=>({document_id:id})),()=>selectNode(n),'读取本版正文');
 if(refs.length)showSourceButtons(refs,()=>selectNode(n),n.document_ids?.length?'读取日期与版本依据':n.source_text_status==='bundled_attachment'?'读取附件正文与依据':'读取沿革依据');
 else if(!n.document_ids?.length)detailRoot().append(el('p','note','未收录本版独立正文；此旧分区尚未提供节点级沿革依据入口。'));
}
function renderVersionTimeline(f,root){
 const versions=[...(familyVersions.get(f.id)||[])].sort(compareVersions),known=versions.filter(v=>versionDate(v)),unknown=versions.filter(v=>!versionDate(v));
 root.append(el('h3','','版本沿革'),el('p','note','有明确版本标识日期的记录按日期排序；时间未知记录单独列出。版次年份不替代公布或施行日期。'));
 if(!versions.length){root.append(el('div','empty','当前尚未收录版本记录。'));return;}
 for(const [label,items] of [['有日期的版本 · 新到旧',known],['时间次序未确定的版本',unknown]]){
  if(!items.length)continue;root.append(el('h3','version-group-title',`${label}（${items.length}）`));const list=el('ol','timeline');
  for(const v of items){
   const li=el('li',''),card=el('article','version-card'),top=el('div','version-top');top.append(el('span','version-date',versionLabel(v)),badge(v));card.append(top);
   const dates=el('dl','date-row');for(const [key,value] of [['公布',v.publish_date],['修订／修正',v.revision_date],['施行',v.effective_date]]){const cell=el('div','');cell.append(el('dt','',key),el('dd','',value||'未确认'));dates.append(cell);}
   card.append(dates,el('p','muted small',sourceStatus(v)),button('查看记录与依据',()=>selectNode(v)));
   for(const e of data.relations.filter(e=>e.from===v.id&&byId.get(e.to)?.kind==='Version'&&familyOf.get(e.to)===f.id&&e.type!=='HAS_VERSION'))card.append(button(`${names[e.type]} → ${versionLabel(byId.get(e.to))} · 事件施行 ${e.date||'未确认'}`,()=>selectEdge(e),'history-event'));
   li.append(card);list.append(li);
  }root.append(list);
 }
}
