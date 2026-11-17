// ===== Flatbed: documents and photos are two separate pipelines =====
const $=id=>document.getElementById(id);
const say=(t,e)=>{const s=$('status');s.textContent=t;s.className='status'+(e?' err':'')};
const show=(id,on)=>$(id).classList.toggle('hide',!on);
const hasClaude=()=>typeof claude!=='undefined'&&claude&&typeof claude.use==='function';
const toBlob=(c,t,q)=>new Promise(r=>c.toBlob(r,t,q));
const dims=s=>[s.naturalWidth||s.width,s.naturalHeight||s.height];
// Optional: URL of your own server. It receives a JPEG (POST body) and returns JSON:
// {"kind":"text"|"table","blocks":[{"type":"heading|paragraph|list","text":""}],"table":null|{"rows":[[""]]}}
const OCR_ENDPOINT='';
let mode='doc',cur=null,pts=null,doc=null,stream=null,anim=null,srcName='';
const pbase=document.createElement('canvas');

// The original file is only READ (as a copy in memory). Every export is a brand new file
// named after the original plus a suffix, so the original is never overwritten or changed.
function outName(suffix,ext){
  let base=(srcName||'').replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]+/g,'_').trim();
  if(!base){const d=new Date(),p=n=>String(n).padStart(2,'0');base='camera-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())}
  return base+'-'+suffix+'.'+ext;
}
async function save(name,data){
  const blob=data instanceof Blob?data:new Blob([data]);
  if(hasClaude()){try{const d=await claude.use('downloads');if(d){await d.save({filename:name,data:blob});say('Saved as a new file: '+name+'. Your original was not changed.');return}}
    catch(e){if(e&&e.code==='declined'){say('Download cancelled.');return}}}
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000);say('Saved as a new file: '+name+'. Your original was not changed.');
}

// ----- mode tabs -----
const hints={doc:'Scan a page, list or handout. It becomes an editable Word, Excel, PowerPoint or PDF file.',photo:'Open a photo to make it black and white, sharper or animated, then save it.'};
function setMode(m){mode=m;document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-selected',b.dataset.mode===m));
  $('pickhint').textContent=hints[m];if(cur)enter();else say(m==='doc'?'Documents: choose the live camera or a file from your device.':'Photos: choose the live camera or a photo from your device.')}
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));

// ----- input: live camera or local file -----
function loadFile(f){if(!f)return;srcName=f.name||'';const im=new Image();im.onload=()=>{cur=im;enter();URL.revokeObjectURL(im.src)};
  im.onerror=()=>say('That file could not be opened as an image.',1);im.src=URL.createObjectURL(f)}
$('file').onchange=e=>loadFile(e.target.files[0]);$('camfile').onchange=e=>loadFile(e.target.files[0]);
async function openCam(){
  try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
    const v=$('cam');v.srcObject=stream;await v.play();show('pick',0);show('camwrap',1);say('Fill the frame with the page or photo, then press Capture.')}
  catch(e){say('The live camera is not available here, so your device camera app is opening instead.',1);$('camfile').click()}
}
function closeCam(){if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;show('camwrap',0)}
$('cambtn').onclick=openCam;
$('camx').onclick=()=>{closeCam();show('pick',1);say('Camera closed.')};
$('snap').onclick=()=>{const v=$('cam'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);closeCam();srcName='';cur=c;enter()};
function enter(){closeCam();show('pick',0);show('doc',mode==='doc');show('photo',mode==='photo');stopAnim();mode==='doc'?setupDoc():setupPhoto()}
function clearAll(msg){closeCam();stopAnim();cur=pts=doc=null;srcName='';
  ['src','out','ref','pv','av'].forEach(i=>{$(i).width=$(i).height=0});pbase.width=pbase.height=0;
  $('file').value=$('camfile').value='';$('blocks').innerHTML=$('tbl').innerHTML='';
  show('doc',0);show('photo',0);show('s-edit',0);show('s-exp',0);show('pick',1);say(msg||'Cleared. Nothing is kept on this page.')}
document.querySelectorAll('[data-clear]').forEach(b=>b.onclick=()=>clearAll());
function maybeClear(){if([...document.querySelectorAll('.autoclear')].some(c=>c.checked&&c.closest(mode==='doc'?'#doc':'#photo')))clearAll('Saved. The scan was cleared from this page.')}

// ===================== DOCUMENTS =====================
function setupDoc(){
  const [iw,ih]=dims(cur),sc=Math.min(1,1600/Math.max(iw,ih)),c=$('src');
  c.width=Math.round(iw*sc);c.height=Math.round(ih*sc);c.getContext('2d').drawImage(cur,0,0,c.width,c.height);
  pts=guess(c);drawPoly();doc=null;$('out').width=$('out').height=0;show('s-edit',0);show('s-exp',0);
  say('Corners were found automatically. Adjust the dots if needed, then press Scan and clean.');
}
function doFlatten(){
  const d=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  let w=Math.max(d(pts[0],pts[1]),d(pts[3],pts[2])),h=Math.max(d(pts[0],pts[3]),d(pts[1],pts[2]));
  if(w<50||h<50){say('The corners are too close together. Spread them out to the page edges.',1);return false}
  const k=Math.min(1,1600/Math.max(w,h));w=Math.round(w*k);h=Math.round(h*k);
  const s=$('src'),sd=s.getContext('2d').getImageData(0,0,s.width,s.height),o=$('out');o.width=w;o.height=h;
  const ox=o.getContext('2d'),od=ox.createImageData(w,h),H=homography([[0,0],[w,0],[w,h],[0,h]],pts);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const z=H[6]*x+H[7]*y+1,u=(H[0]*x+H[1]*y+H[2])/z,v=(H[3]*x+H[4]*y+H[5])/z;
    const x0=Math.floor(u),y0=Math.floor(v),fx=u-x0,fy=v-y0,i=(y*w+x)*4;
    od.data[i+3]=255;
    if(x0<0||y0<0||x0>=s.width-1||y0>=s.height-1){od.data[i]=od.data[i+1]=od.data[i+2]=255;continue}
    for(let c=0;c<3;c++){const g=(xx,yy)=>sd.data[(yy*s.width+xx)*4+c];
      od.data[i+c]=g(x0,y0)*(1-fx)*(1-fy)+g(x0+1,y0)*fx*(1-fy)+g(x0,y0+1)*(1-fx)*fy+g(x0+1,y0+1)*fx*fy}}
  ox.putImageData(od,0,0);clean(o);show('s-exp',1);return true;
}
function clean(o){ // even out the lighting but KEEP the original colours (black and white only if chosen)
  const w=o.width,h=o.height,ox=o.getContext('2d'),d=ox.getImageData(0,0,w,h),px=d.data;
  const bw=!!$('cleanmode')&&$('cleanmode').value==='bw';
  if(bw){ // optional scanner look: grey, high contrast
    const sm=document.createElement('canvas');sm.width=Math.max(8,w>>4);sm.height=Math.max(8,h>>4);
    const sx=sm.getContext('2d');sx.imageSmoothingQuality='high';sx.drawImage(o,0,0,sm.width,sm.height);
    const bg=document.createElement('canvas');bg.width=w;bg.height=h;const bx=bg.getContext('2d');bx.imageSmoothingQuality='high';bx.drawImage(sm,0,0,w,h);
    const b=bx.getImageData(0,0,w,h).data;
    for(let i=0;i<px.length;i+=4){
      const g=.3*px[i]+.59*px[i+1]+.11*px[i+2],bl=.3*b[i]+.59*b[i+1]+.11*b[i+2]+1;
      const r=Math.max(0,Math.min(1,(g/bl-.55)/.4))*255;px[i]=px[i+1]=px[i+2]=r}
  }else{
    // Lighting map from the PAPER only (bright, nearly colourless cells), so big coloured blocks, photos and
    // dark areas are never mistaken for shadow. Holes are filled from the nearest paper, then smoothed.
    // Every colour channel is scaled by the SAME factor: shadows go away and colours stay as they were.
    const sw=Math.max(16,Math.round(w/8)),sh=Math.max(16,Math.round(h/8)),n=sw*sh;
    const sm=document.createElement('canvas');sm.width=sw;sm.height=sh;
    const sx=sm.getContext('2d');sx.imageSmoothingQuality='high';sx.drawImage(o,0,0,sw,sh);
    const sd=sx.getImageData(0,0,sw,sh).data,lum=new Float32Array(n);
    for(let i=0;i<n;i++)lum[i]=.3*sd[i*4]+.59*sd[i*4+1]+.11*sd[i*4+2];
    const P=Array.from(lum).sort((p,q)=>p-q)[Math.floor(n*.95)];
    if(P>=100){
      const paper=new Float32Array(n);
      for(let i=0;i<n;i++){const c=Math.max(sd[i*4],sd[i*4+1],sd[i*4+2])-Math.min(sd[i*4],sd[i*4+1],sd[i*4+2]);
        paper[i]=(lum[i]>.5*P&&c<.2*lum[i])?lum[i]:0}
      // brightest paper nearby, so small text never darkens the samples
      const r=Math.max(2,Math.round(sw/16)),tmp=new Float32Array(n),mx=new Float32Array(n);
      for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){let m=0;for(let k=Math.max(0,x-r);k<=Math.min(sw-1,x+r);k++)if(paper[y*sw+k]>m)m=paper[y*sw+k];tmp[y*sw+x]=m}
      for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){let m=0;for(let k=Math.max(0,y-r);k<=Math.min(sh-1,y+r);k++)if(tmp[k*sw+x]>m)m=tmp[k*sw+x];mx[y*sw+x]=m}
      // Light on a page is smooth, so fit ONE smooth curved surface to the paper samples.
      // Nothing inside coloured blocks or photos can then be brightened or blotched.
      const smp=[];for(let i=0;i<n;i++)if(paper[i])smp.push(i);
      if(smp.length>=40){
        const A=Array.from({length:6},()=>new Array(6).fill(0)),bv=new Array(6).fill(0),basis=(u,v)=>[1,u,v,u*v,u*u,v*v];
        let lo=1e9,hi=0;
        for(const i of smp){const e=basis((i%sw)/sw-.5,Math.floor(i/sw)/sh-.5),y=mx[i];lo=Math.min(lo,y);hi=Math.max(hi,y);
          for(let p=0;p<6;p++){bv[p]+=e[p]*y;for(let q=0;q<6;q++)A[p][q]+=e[p]*e[q]}}
        for(let p=1;p<6;p++)A[p][p]+=1e-3*smp.length;
        const cf=solve(A,bv),lc=document.createElement('canvas');lc.width=sw;lc.height=sh;
        const lx=lc.getContext('2d'),li=lx.createImageData(sw,sh);
        for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){const e=basis(x/sw-.5,y/sh-.5);let L=0;for(let p=0;p<6;p++)L+=cf[p]*e[p];
          L=Math.max(lo*.9,Math.min(hi*1.05,L));const k=(y*sw+x)*4;li.data[k]=li.data[k+1]=li.data[k+2]=Math.min(255,L);li.data[k+3]=255}
        lx.putImageData(li,0,0);
        const bg=document.createElement('canvas');bg.width=w;bg.height=h;const bx=bg.getContext('2d');bx.imageSmoothingQuality='high';bx.drawImage(lc,0,0,w,h);
        const b=bx.getImageData(0,0,w,h).data;
        for(let i=0;i<px.length;i+=4){
          const f=Math.min(1.8,255/(Math.max(60,b[i])*.97)); // gentle: at most 1.8x
          px[i]=Math.min(255,px[i]*f);px[i+1]=Math.min(255,px[i+1]*f);px[i+2]=Math.min(255,px[i+2]*f)}
      }
    } // a very dark page is left exactly as it is
  }
  if($('rules').checked){ // optional: erase long, thin horizontal lines (notebook ruling)
    const dk=new Uint8Array(w*h),lim=bw?150:190;
    for(let i=0;i<w*h;i++)dk[i]=(.3*px[i*4]+.59*px[i*4+1]+.11*px[i*4+2])<lim?1:0;
    const min=Math.round(w*.1);
    for(let y=4;y<h-4;y++){const on=i=>dk[y*w+i]||dk[(y-1)*w+i]||dk[(y+1)*w+i];let x=0;
      while(x<w){if(!on(x)){x++;continue}const s=x;while(x<w&&on(x))x++;
        if(x-s>=min){let thick=0;for(let k=s;k<x;k++)if(dk[(y-4)*w+k]&&dk[(y+4)*w+k])thick++;
          if(thick<(x-s)*.3)for(let k=s;k<x;k++){const p=(y*w+k)*4;px[p]=px[p+1]=px[p+2]=255}}}}
  }
  ox.putImageData(d,0,0);
}
async function doRead(){
  say('Reading the page…');
  try{const blob=await toBlob($('out'),'image/jpeg',.85);let r=null;
    if(hasClaude()){try{r=await readWithClaude(blob)}catch(e){r=null}}
    if(!r&&OCR_ENDPOINT){const res=await fetch(OCR_ENDPOINT,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob});if(!res.ok)throw new Error('server error '+res.status);r=await res.json()}
    if(!r)r=await readLocal();
    if(!r||typeof r!=='object')throw new Error('unexpected reply');
    r.blocks=Array.isArray(r.blocks)?r.blocks:[];
    if(!r.table||!Array.isArray(r.table.rows)||!r.table.rows.length)r.table=null;
    doc=r;renderEdit();return true}
  catch(e){say('Could not read the page'+(e&&e.message?': '+e.message:'.')+' You can still export it as a PDF.',1);return false}
}
const ensureDoc=async()=>doc||(await doRead()?doc:null);

// How Word / PowerPoint keep the page:
//  image = the cleaned scan IS the page (original look is kept exactly)  <- default
//  both  = the page image first, then the editable text after it
//  text  = rebuilt from OCR only (layout can change)
const wmode=()=>($('wmode')&&$('wmode').value)||'image';
const needsText=k=>k==='xlsx'||((k==='docx'||k==='pptx')&&wmode()!=='image');

$('go').onclick=async()=>{const g=$('go');g.disabled=true;
  if(doFlatten()){const f=$('fmt').value;
    if(f==='pdf')await exportAs('pdf');
    else if((f==='docx'||f==='pptx')&&wmode()==='image')await exportAs(f); // no reading needed, keeps the original look
    else if(await doRead()&&f!=='ask')await exportAs(f==='auto'?(doc.kind==='table'?'xlsx':'docx'):f);
    else if(f==='ask')say('Done. Check the text, then choose an export format.')}
  g.disabled=false};
document.querySelectorAll('[data-x]').forEach(b=>b.onclick=()=>exportAs(b.dataset.x));
async function exportAs(k){
  try{
    if(!$('out').width){say('Press Scan and clean first.',1);return}
    if(k==='pdf')await save(outName('scanned','pdf'),await pdfFrom($('out')));
    else{
      if(needsText(k)&&!await ensureDoc())return;
      if(k==='docx')await save(outName('scanned','docx'),await makeDocx());
      if(k==='xlsx')await save(outName('scanned','xlsx'),makeXlsx());
      if(k==='pptx')await save(outName('scanned','pptx'),await makePptx())}
    maybeClear();
  }catch(e){say('Export failed: '+((e&&e.message)||e),1)}
}
async function pdfFrom(c){const J=window.jspdf&&window.jspdf.jsPDF;if(!J)throw new Error('the PDF builder did not load. Check your connection');
  const p=new J({unit:'px',format:[c.width,c.height],orientation:c.width>c.height?'l':'p',compress:true});
  p.addImage(c.toDataURL('image/jpeg',.92),'JPEG',0,0,c.width,c.height);return p.output('blob')}

// the cleaned page as bytes + data URL, used to keep the original look
async function pageImage(){
  const c=$('out'),blob=await toBlob(c,'image/jpeg',.92);
  return{bytes:new Uint8Array(await blob.arrayBuffer()),url:c.toDataURL('image/jpeg',.92),w:c.width,h:c.height};
}

async function makeDocx(){
  const D=window.docx;if(!D)throw new Error('the Word builder did not load. Check your connection');
  const m=wmode(),kids=[];
  // A4 at 96 dpi = 794 x 1123 px. 0.5 inch margins = 48 px.
  const MARGIN=720,PW=794-96,PH=1123-96-14;
  if(m!=='text'){
    const im=await pageImage(),k=Math.min(PW/im.w,PH/im.h);
    kids.push(new D.Paragraph({alignment:D.AlignmentType.CENTER,spacing:{before:0,after:0},
      children:[new D.ImageRun({data:im.bytes,transformation:{width:Math.max(1,Math.round(im.w*k)),height:Math.max(1,Math.round(im.h*k))}})]}));
    if(m==='both')kids.push(new D.Paragraph({children:[new D.PageBreak()]}));
  }
  if(m!=='image'&&doc){
    doc.blocks.forEach(b=>{const tx=(b.text||'').trim();if(!tx)return;
      if(b.type==='heading')kids.push(new D.Paragraph({text:tx,heading:D.HeadingLevel.HEADING_1,spacing:{after:160}}));
      else if(b.type==='list')tx.split('\n').filter(Boolean).forEach(l=>kids.push(new D.Paragraph({text:l.replace(/^[-•*\d.\s]+/,''),bullet:{level:0}})));
      else tx.split('\n').filter(Boolean).forEach(l=>kids.push(new D.Paragraph({text:l,spacing:{after:140}})))});
    if(doc.table){kids.push(new D.Paragraph({text:''}));
      kids.push(new D.Table({width:{size:100,type:D.WidthType.PERCENTAGE},rows:doc.table.rows.map((r,ri)=>new D.TableRow({children:r.map(c=>new D.TableCell({children:[new D.Paragraph({children:[new D.TextRun({text:String(c||''),bold:ri===0})]})]}))}))}))}
  }
  if(!kids.length)kids.push(new D.Paragraph({text:''}));
  return D.Packer.toBlob(new D.Document({sections:[{
    properties:{page:{size:{width:11906,height:16838},margin:{top:MARGIN,right:MARGIN,bottom:MARGIN,left:MARGIN,header:300,footer:300}}},
    children:kids}]}));
}
function makeXlsx(){
  if(!window.XLSX)throw new Error('the Excel builder did not load. Check your connection');let rows;
  if(doc.table)rows=[...doc.blocks.map(b=>[b.text||'']).filter(r=>r[0]),[],...doc.table.rows];
  else rows=doc.blocks.flatMap(b=>(b.text||'').split('\n').filter(Boolean).map(l=>[l]));
  const ws=XLSX.utils.aoa_to_sheet(rows.length?rows:[['']]),wb=XLSX.utils.book_new();
  if(doc.table)ws['!cols']=doc.table.rows[0].map((_,i)=>({wch:Math.min(40,Math.max(10,...doc.table.rows.map(r=>String(r[i]||'').length+2)))}));
  XLSX.utils.book_append_sheet(wb,ws,'Scan');return new Uint8Array(XLSX.write(wb,{type:'array',bookType:'xlsx'}));
}
async function makePptx(){
  if(!window.PptxGenJS)throw new Error('the PowerPoint builder did not load. Check your connection');
  const m=wmode(),p=new PptxGenJS();
  if(m==='image'){ // one slide shaped exactly like the page, with the scan filling it
    const im=await pageImage(),H=7.5,W=Math.max(3,Math.min(20,H*im.w/im.h));
    p.defineLayout({name:'SCAN',width:W,height:H});p.layout='SCAN';
    p.addSlide().addImage({data:im.url,x:0,y:0,w:W,h:H});
    return p.write({outputType:'blob'});
  }
  p.layout='LAYOUT_WIDE';
  if(m==='both'){
    const im=await pageImage(),bw=12.5,bh=7.1,r=im.w/im.h;let w=bh*r,h=bh;if(w>bw){w=bw;h=bw/r}
    p.addSlide().addImage({data:im.url,x:(13.33-w)/2,y:(7.5-h)/2,w,h});
  }
  const slides=[];let cs=null;
  doc.blocks.forEach(b=>{const tx=(b.text||'').trim();if(!tx)return;
    if(b.type==='heading'||!cs){cs={title:b.type==='heading'?tx:'Scanned document',items:[]};slides.push(cs);if(b.type==='heading')return}
    tx.split('\n').filter(Boolean).forEach(l=>cs.items.push({text:l,options:{bullet:true,breakLine:true}}))});
  if(!slides.length&&!doc.table&&m==='text')slides.push({title:'Scanned document',items:[]});
  const title=(s,t)=>s.addText(t,{x:.6,y:.4,w:12.1,h:.9,fontSize:30,bold:true,color:'0E5F68'});
  slides.forEach(sl=>{const s=p.addSlide();title(s,sl.title);if(sl.items.length)s.addText(sl.items,{x:.6,y:1.5,w:12.1,h:5.2,fontSize:20,valign:'top',fit:'shrink'})});
  if(doc.table){const s=p.addSlide();title(s,slides.length?'Table':'Scanned table');
    s.addTable(doc.table.rows.map((r,ri)=>r.map(c=>({text:String(c||''),options:ri===0?{bold:true,fill:{color:'D8F3F6'}}:{}}))),{x:.6,y:1.5,w:12.1,fontSize:14,border:{type:'solid',color:'B8D8DC',pt:1}})}
  return p.write({outputType:'blob'});
}

// ===================== PHOTOS =====================
function setupPhoto(){
  const [iw,ih]=dims(cur),sc=Math.min(1,2400/Math.max(iw,ih));
  pbase.width=Math.round(iw*sc);pbase.height=Math.round(ih*sc);pbase.getContext('2d').drawImage(cur,0,0,pbase.width,pbase.height);
  $('bw').checked=false;$('enh').value=0;processPhoto();
  say('Photo loaded. Try black and white, Enhance or an animation, then save it.');
}
function processPhoto(){
  const o=$('pv'),w=pbase.width,h=pbase.height;o.width=w;o.height=h;const x=o.getContext('2d');x.drawImage(pbase,0,0);
  const s=$('enh').value/100,bw=$('bw').checked;if(!s&&!bw)return;
  const id=x.getImageData(0,0,w,h),d=id.data;
  if(s){ // unsharp mask, then stretch the levels
    const src=new Uint8ClampedArray(d),amt=s*2,w4=w*4;
    for(let y=1;y<h-1;y++)for(let xx=1;xx<w-1;xx++){const i=(y*w+xx)*4;
      for(let c=0;c<3;c++){const j=i+c,bl=(src[j-4]+src[j+4]+src[j-w4]+src[j+w4]+src[j-w4-4]+src[j-w4+4]+src[j+w4-4]+src[j+w4+4]+src[j])/9;
        d[j]=src[j]+amt*(src[j]-bl)}}
    const hist=new Uint32Array(256);for(let i=0;i<d.length;i+=4)hist[Math.round(.3*d[i]+.59*d[i+1]+.11*d[i+2])]++;
    const tot=w*h;let a=0,lo=0,hi=255;for(let v=0;v<256;v++){a+=hist[v];if(a>tot*.01){lo=v;break}}a=0;for(let v=255;v>=0;v--){a+=hist[v];if(a>tot*.01){hi=v;break}}
    lo*=s;hi=255-(255-hi)*s;const k=255/Math.max(40,hi-lo);
    for(let i=0;i<d.length;i+=4)for(let c=0;c<3;c++)d[i+c]=(d[i+c]-lo)*k}
  if(bw)for(let i=0;i<d.length;i+=4){const g=.3*d[i]+.59*d[i+1]+.11*d[i+2];d[i]=d[i+1]=d[i+2]=g}
  x.putImageData(id,0,0);
}
let pt=0;const later=()=>{clearTimeout(pt);pt=setTimeout(processPhoto,60)};
$('bw').onchange=later;$('enh').oninput=later;
function frame(t,fx){const o=$('pv'),av=$('av'),x=av.getContext('2d'),e=.5-.5*Math.cos(Math.PI*2*t);let z=1,cx=.5,cy=.5;
  if(fx==='zoom')z=1+.22*e;else if(fx==='pan'){z=1.2;cx=.15+.7*e}else{z=1.1;cx=.5+.4*Math.sin(Math.PI*2*t);cy=.5+.4*Math.cos(Math.PI*4*t)}
  const sw=o.width/z,sh=o.height/z;x.drawImage(o,(o.width-sw)*cx,(o.height-sh)*cy,sw,sh,0,0,av.width,av.height)}
function stopAnim(){if(anim){cancelAnimationFrame(anim.id);anim=null}show('av',0);show('pv',1)}
function playAnim(){stopAnim();const o=$('pv'),av=$('av');if(!o.width)return;
  av.width=2*Math.round(Math.min(o.width,1280)/2);av.height=2*Math.round(av.width*o.height/o.width/2);
  show('pv',0);show('av',1);const t0=performance.now(),f=$('fx').value;anim={id:0};
  const step=n=>{frame(((n-t0)%4000)/4000,f);anim&&(anim.id=requestAnimationFrame(step))};step(t0)}
$('play').onclick=()=>anim?stopAnim():playAnim();$('fx').onchange=()=>{if(anim)playAnim()};
$('rec').onclick=()=>{
  if(!window.MediaRecorder||!$('av').captureStream){say('Recording is not supported in this browser.',1);return}
  playAnim();const mt=['video/webm;codecs=vp9','video/webm','video/mp4'].find(m=>MediaRecorder.isTypeSupported(m));
  const rc=new MediaRecorder($('av').captureStream(30),mt?{mimeType:mt}:{}),ch=[];
  rc.ondataavailable=e=>e.data.size&&ch.push(e.data);
  rc.onstop=async()=>{stopAnim();await save(outName('animated',rc.mimeType.includes('mp4')?'mp4':'webm'),new Blob(ch,{type:rc.mimeType}));maybeClear()};
  say('Recording a 4 second animation…');rc.start();setTimeout(()=>rc.stop(),4000)};
$('dl-img').onclick=async()=>{const f=$('pf').value,m='image/'+f,b=await toBlob($('pv'),m,.92);
  if(!b||b.type!==m){say('This browser cannot save '+f.toUpperCase()+'.',1);return}
  await save(outName('edited',f==='jpeg'?'jpg':f),b);maybeClear()};
$('dl-ppdf').onclick=async()=>{try{await save(outName('edited','pdf'),await pdfFrom($('pv')));maybeClear()}catch(e){say('Export failed: '+e.message,1)}};

function guess(c){ // finds the page by colour/brightness difference from the surface, keeps the most rectangular blob
  const w=96,h=Math.max(8,Math.round(96*c.height/c.width)),t=document.createElement('canvas');t.width=w;t.height=h;
  const x=t.getContext('2d');x.drawImage(c,0,0,w,h);const d=x.getImageData(0,0,w,h).data,n=w*h;
  const bd=[];for(let i=0;i<w;i++)bd.push(i,(h-1)*w+i);for(let j=0;j<h;j++)bd.push(j*w,j*w+w-1);
  const med=f=>bd.map(f).sort((p,q)=>p-q)[bd.length>>1];
  const bg=[0,1,2].map(ch=>med(p=>d[p*4+ch])),rg=med(p=>d[p*4]-d[p*4+1]),gb=med(p=>d[p*4+1]-d[p*4+2]);
  const f1=new Float32Array(n),f2=new Float32Array(n);
  for(let i=0;i<n;i++){const r=d[i*4],g=d[i*4+1],b=d[i*4+2];f1[i]=Math.hypot(r-bg[0],g-bg[1],b-bg[2]);f2[i]=Math.hypot(r-g-rg,g-b-gb)}
  const otsu=f=>{let mx=1e-9;for(const v of f)if(v>mx)mx=v;const bins=new Array(64).fill(0);f.forEach(v=>bins[Math.min(63,Math.floor(v/mx*63))]++);
    let sa=0;bins.forEach((k,i)=>sa+=i*k);let wb=0,sb=0,best=-1,th=0;
    for(let i=0;i<64;i++){wb+=bins[i];if(!wb)continue;const wf=n-wb;if(!wf)break;sb+=i*bins[i];const s=wb*wf*Math.pow(sb/wb-(sa-sb)/wf,2);if(s>best){best=s;th=i}}
    return (th+1)/63*mx};
  let top=null,topScore=0;
  [f1,f2].forEach(f=>{const lim=Math.max(8,otsu(f)),m=new Uint8Array(n),seen=new Uint8Array(n);for(let i=0;i<n;i++)m[i]=f[i]>lim?1:0;
    for(let s=0;s<n;s++){if(!m[s]||seen[s])continue;const st=[s],px=[];seen[s]=1;
      while(st.length){const p=st.pop();px.push(p);const X=p%w,Y=(p/w)|0;
        for(const q of [X>0&&p-1,X<w-1&&p+1,Y>0&&p-w,Y<h-1&&p+w])if(q!==false&&m[q]&&!seen[q]){seen[q]=1;st.push(q)}}
      if(px.length<n*.04)continue;
      let sx=0,sy=0,e=0,x0=w,x1=0,y0=h,y1=0;px.forEach(p=>{const X=p%w,Y=(p/w)|0;sx+=X;sy+=Y;x0=Math.min(x0,X);x1=Math.max(x1,X);y0=Math.min(y0,Y);y1=Math.max(y1,Y)});
      e=(x0===0)+(x1===w-1)+(y0===0)+(y1===h-1);
      const k=g=>px.reduce((a,p)=>g(p%w,(p/w)|0)>g(a%w,(a/w)|0)?p:a,px[0]);
      const cs=[k((X,Y)=>-(X+Y)),k((X,Y)=>X-Y),k((X,Y)=>X+Y),k((X,Y)=>Y-X)].map(p=>[p%w,(p/w)|0]);
      let qa=0;for(let i=0;i<4;i++){const A=cs[i],B=cs[(i+1)%4];qa+=A[0]*B[1]-B[0]*A[1]}qa=Math.abs(qa)/2+1;
      const fill=Math.min(1,px.length/qa),cen=1-.6*Math.hypot(sx/px.length/w-.5,sy/px.length/h-.5);
      const sc=px.length*Math.pow(fill,3)*cen*(e>=3?.2:1);if(sc>topScore){topScore=sc;top=cs}}});
  const W=c.width/w,H=c.height/h;
  if(top)return top.map(p=>[(p[0]+.5)*W,(p[1]+.5)*H]);
  return [[.08*c.width,.08*c.height],[.92*c.width,.08*c.height],[.92*c.width,.92*c.height],[.08*c.width,.92*c.height]];
}
function drawPoly(){
  const c=$('src'),box=$('cropbox');box.querySelectorAll('.h').forEach(n=>n.remove());
  const svg=$('poly');svg.setAttribute('viewBox',`0 0 ${c.width} ${c.height}`);
  svg.firstElementChild.setAttribute('points',pts.map(p=>p.join(',')).join(' '));
  pts.forEach((p,i)=>{
    const h=document.createElement('div');h.className='h';h.tabIndex=0;h.setAttribute('aria-label','Corner '+(i+1));
    h.style.left=p[0]/c.width*100+'%';h.style.top=p[1]/c.height*100+'%';
    h.onpointerdown=e=>{h.setPointerCapture(e.pointerId);h.onpointermove=ev=>{
      const r=c.getBoundingClientRect();
      pts[i]=[Math.max(0,Math.min(c.width,(ev.clientX-r.left)/r.width*c.width)),Math.max(0,Math.min(c.height,(ev.clientY-r.top)/r.height*c.height))];
      h.style.left=pts[i][0]/c.width*100+'%';h.style.top=pts[i][1]/c.height*100+'%';
      svg.firstElementChild.setAttribute('points',pts.map(q=>q.join(',')).join(' '))};
      h.onpointerup=()=>{h.onpointermove=null}};
    box.appendChild(h);
  });
}
// perspective warp
function solve(A,b){const n=b.length;for(let i=0;i<n;i++){let m=i;for(let r=i+1;r<n;r++)if(Math.abs(A[r][i])>Math.abs(A[m][i]))m=r;[A[i],A[m]]=[A[m],A[i]];[b[i],b[m]]=[b[m],b[i]];
  for(let r=i+1;r<n;r++){const f=A[r][i]/A[i][i];for(let k=i;k<n;k++)A[r][k]-=f*A[i][k];b[r]-=f*b[i]}}
  const x=Array(n).fill(0);for(let i=n-1;i>=0;i--){let s=b[i];for(let k=i+1;k<n;k++)s-=A[i][k]*x[k];x[i]=s/A[i][i]}return x}
function homography(dst,src){const A=[],b=[];
  for(let i=0;i<4;i++){const[x,y]=dst[i],[u,v]=src[i];
    A.push([x,y,1,0,0,0,-x*u,-y*u]);b.push(u);A.push([0,0,0,x,y,1,-x*v,-y*v]);b.push(v)}
  return solve(A,b)}
async function readWithClaude(blob){ // used only inside claude.ai
  const sample=await claude.use('sample');if(!sample)return null;
  const lim=await sample.limits().catch(()=>null);if(!lim||!lim.images)return null;
  const prompt=`Transcribe the attached scanned document faithfully. Keep the original wording, language and order. Do not invent text; use "?" for illegible parts.
Return ONLY JSON in this shape:
{"kind":"text"|"table","blocks":[{"type":"heading"|"paragraph"|"list","text":"..."}],"table":null|{"rows":[["cell","cell"]]}}
Rules: "kind" is "table" if the page is mainly a grid such as an attendance list, schedule or grade sheet. A flow chart, diagram or figure is NOT a table: skip its drawn boxes and arrows, and only keep its caption as a paragraph. Put any title or text outside the grid in "blocks". Put the grid in "table.rows" with the header row first, every row with the same number of cells, empty cells as "". For a "list" block, separate items with newline characters.`;
  return sample.json(prompt,{images:[blob],modelTier:'default',cache:false});
}

function ocrCanvas(){ // grey, high-contrast copy for the text reader only
  const o=$('out'),c=document.createElement('canvas');c.width=o.width;c.height=o.height;const x=c.getContext('2d');x.drawImage(o,0,0);
  const d=x.getImageData(0,0,c.width,c.height),p=d.data;
  for(let i=0;i<p.length;i+=4){const g=.3*p[i]+.59*p[i+1]+.11*p[i+2],v=Math.max(0,Math.min(255,(g-90)*255/145));p[i]=p[i+1]=p[i+2]=v}
  x.putImageData(d,0,0);return c}
async function readLocal(){ // free, in-browser OCR (Tesseract.js)
  if(!window.Tesseract)throw new Error('the OCR engine did not load. Check your connection and reload');
  const r=await Tesseract.recognize(ocrCanvas(),$('lang').value,{logger:m=>{if(m.status==='recognizing text')say('Reading the page… '+Math.round(m.progress*100)+'%')}});
  return layout(r.data);
}

// Turns OCR lines + word positions into headings, paragraphs, lists and a table.
// Noise from diagrams, borders and page edges (garbage like "= RE SR SNR |") is dropped here.
function layout(data){
  const W=$('out').width,PIPE=/[|¦]/g;
  const goodLine=l=>{const t=l.text.replace(PIPE,' ').trim(),flat=t.replace(/\s/g,''),al=(t.match(/[A-Za-z0-9]/g)||[]).length;
    return flat.length>0&&al>=2&&al/flat.length>=.65&&l.confidence>=55};
  const L=(data.lines||(data.blocks||[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines))).filter(goodLine);
  if(!L.length)return{kind:'text',blocks:[],table:null};
  const hs=L.map(l=>l.bbox.y1-l.bbox.y0).sort((x,y)=>x-y),med=hs[hs.length>>1]||20;
  L.forEach(l=>{ // split each line into cells wherever there is a wide gap
    l.h=l.bbox.y1-l.bbox.y0;l.clean=l.text.replace(PIPE,' ').replace(/\s+/g,' ').trim();l.cells=[];let cur=null,prev=null;
    l.words.filter(w=>w.text.replace(PIPE,'').trim()&&w.confidence>=50).forEach(w=>{
      if(cur&&w.bbox.x0-prev.bbox.x1>Math.max(med*1.3,12))cur=null;
      if(!cur){cur={t:'',x:w.bbox.x0};l.cells.push(cur)}
      cur.t+=(cur.t?' ':'')+w.text.replace(PIPE,'');prev=w});
  });
  let t=L.map(l=>l.cells.length>=2);
  t=t.map((v,i)=>v||(i>0&&i<L.length-1&&t[i-1]&&t[i+1])); // a one-cell row between table rows stays in the table
  const inTable=Array(L.length).fill(false);
  for(let i=0;i<L.length;){if(!t[i]){i++;continue}let j=i;while(j<L.length&&t[j])j++;if(j-i>=4)for(let k=i;k<j;k++)inTable[k]=true;i=j}
  // column anchors from the x position of every table cell
  const xs=[];L.forEach((l,i)=>{if(inTable[i])l.cells.forEach(c=>xs.push(c.x))});xs.sort((p,q)=>p-q);
  const anchors=[];xs.forEach(x=>{const a=anchors[anchors.length-1];if(a&&x-a.last<W*.035){a.sum+=x;a.n++;a.last=x}else anchors.push({sum:x,n:1,last:x})});
  const cols=anchors.map(a=>a.sum/a.n);
  const rows=[];
  L.forEach((l,i)=>{if(!inTable[i])return;const row=Array(cols.length).fill('');
    l.cells.forEach(c=>{let k=0,best=1e9;cols.forEach((cx,ci)=>{const d=Math.abs(cx-c.x);if(d<best){best=d;k=ci}});row[k]=(row[k]?row[k]+' ':'')+c.t});rows.push(row)});
  // everything else becomes blocks
  const blocks=[];let last=null,prevY=null;
  L.forEach((l,i)=>{
    if(inTable[i]){last=null;return}
    const tx=l.clean,isList=/^([-•*·]|\d+[.)])\s+/.test(tx),letters=tx.replace(/[^A-Za-z]/g,'');
    const isHead=!isList&&(l.h>med*1.35||(letters.length>3&&tx.split(/\s+/).length<=8&&tx===tx.toUpperCase()));
    const type=isHead?'heading':isList?'list':'paragraph';
    const close=prevY!==null&&l.bbox.y0-prevY<med*.9;
    if(last&&close&&last.type===type&&type!=='heading')last.text+=(type==='list'?'\n':' ')+tx;
    else{last={type,text:tx};blocks.push(last)}
    prevY=l.bbox.y1});
  blocks.forEach(b=>{if(b.type==='list')b.text=b.text.split('\n').map(s=>s.replace(/^([-•*·]|\d+[.)])\s+/,'')).join('\n')});
  const share=inTable.filter(Boolean).length/L.length,useTable=rows.length>=4&&cols.length>=2;
  return{kind:share>=.5&&useTable?'table':'text',blocks,table:useTable?{rows}:null};
}
function renderEdit(){
  show('s-edit',1);
  const r=$('ref'),o=$('out');r.width=o.width;r.height=o.height;r.getContext('2d').drawImage(o,0,0);
  $('kind').textContent=doc.kind==='table'?'This looks like a table, so Excel is the best fit. Word works too.':'This looks like a text document, so Word is the best fit.';
  const B=$('blocks');B.innerHTML='';
  doc.blocks.forEach((bl,i)=>{
    const row=document.createElement('div');row.className='blk';
    const s=document.createElement('select');s.setAttribute('aria-label','Block type');
    ['heading','paragraph','list'].forEach(t=>{const op=new Option(t[0].toUpperCase()+t.slice(1),t);if(t===bl.type)op.selected=true;s.add(op)});
    s.onchange=()=>bl.type=s.value;
    const t=document.createElement('textarea');t.value=bl.text||'';t.rows=bl.type==='paragraph'?3:2;t.oninput=()=>bl.text=t.value;
    const x=document.createElement('button');x.className='btn';x.textContent='Remove';x.onclick=()=>{doc.blocks.splice(i,1);renderEdit()};
    row.append(s,t,x);B.append(row)});
  const T=$('tbl');T.innerHTML='';show('tbar',!!doc.table);
  if(doc.table){
    const tb=document.createElement('table');tb.className='ed';
    doc.table.rows.forEach((rw,ri)=>{const tr=tb.insertRow();rw.forEach((v,ci)=>{
      const td=tr.insertCell();td.contentEditable='true';td.textContent=v;if(ri===0)td.style.fontWeight='600';
      td.oninput=()=>doc.table.rows[ri][ci]=td.textContent})});
    T.append(tb)}
  else show('tbar',0);
  say('Check the text against the scan, fix anything that is wrong, then download.');
}
$('addrow').onclick=()=>{const t=doc.table.rows;t.push(Array(t[0].length).fill(''));renderEdit()};
$('addcol').onclick=()=>{doc.table.rows.forEach(r=>r.push(''));renderEdit()};


setMode('doc');