/** content.js — FOSXpress v3.7.1 (+ PDF collector)
 *  - Snippets + placeholders + diálogo + typeahead + soporte mail
 *  - Detección CDU (challenge) + SITE (país) desde el DOM → background/storage
 *  - Gatillo “maf” → toma el texto escrito antes del token, abre panel IA,
 *    valida casuística contra guía (vía Apps Script) y propone mensaje final.
 *  - NUEVO: analyzeWithAI usa background (evita CORS) y ahora envía attachments (PDFs).
 */

console.log("[FOSXpress] content script v3.7.1 + pdf collector loaded");

/* ================ Silenciar SOLO el error de contexto invalidado ================= */
function isContextInvalidatedMsg(msg){
  return /Extension context invalidated/i.test(String(msg || ""));
}
addEventListener("unhandledrejection", (e) => {
  if (isContextInvalidatedMsg(e?.reason?.message || e?.reason)) {
    e.preventDefault();
    console.warn("[FOSXpress] Ignorado: Extension context invalidated (promise)");
  }
});
addEventListener("error", (e) => {
  if (isContextInvalidatedMsg(e?.message)) {
    e.preventDefault();
    console.warn("[FOSXpress] Ignorado: Extension context invalidated (error)");
  }
});

/* ========================== Helpers de contexto ========================== */
function extAlive(){
  try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
  catch { return false; }
}

/* ========================== Cache de snippets ========================== */
let snippetsCache = {};
let snipIndex = new Map();       // case-insensitive
let snipKeysOriginal = [];

function rebuildSnipIndex(){
  snipIndex.clear();
  snipKeysOriginal = [];
  try {
    for (const k in snippetsCache) {
      if (!Object.prototype.hasOwnProperty.call(snippetsCache, k)) continue;
      const key = String(k).trim();
      if (!key.startsWith("/")) continue;
      snipIndex.set(key.toLowerCase(), snippetsCache[k]);   // string u objeto {subject, body}
      snipKeysOriginal.push(key);
    }
    snipKeysOriginal.sort((a,b)=> a.localeCompare(b));
  } catch(_){}
}

try {
  chrome.storage?.local?.get({ snippets: {} }, (r) => {
    if (chrome.runtime?.lastError) return;
    snippetsCache = r?.snippets || {};
    rebuildSnipIndex();
  });
  chrome.storage?.onChanged?.addListener((c, area) => {
    if (area === "local" && c?.snippets) {
      snippetsCache = c.snippets.newValue || {};
      rebuildSnipIndex();
    }
  });
} catch (_) { snippetsCache = {}; rebuildSnipIndex(); }

/* ========================== Utilidades ========================== */
// Macros: {{date}}, {{date+N}}, {{date-N}}, {{time}}
function expandStaticMacros(t) {
  const now = new Date();
  const fmtDate = (d) => d.toISOString().slice(0,10);
  let out = String(t).replace(/\{\{date(?:([+-]\d+))?\}\}/g, (_, off) => {
    if (!off) return fmtDate(now);
    const n = parseInt(off, 10) || 0;
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  });
  out = out.replace(/\{\{time\}\}/g, now.toTimeString().slice(0,5));
  return out;
}

// /atajo antes de espacio o fin, evitando '://', '//'
const RE_SHORTCUT_NEAR_CARET = /(?<![:/])\/[a-zA-Z0-9_-]+(?=\s|$)/g;

// Placeholders
function parsePlaceholders(tpl){
  const tokens=[]; const re=/\{\{(select:([^}|]+)\|([^}]+)|input:([^}|]+)(?:\|([^}]*))?)\}\}/g; let m;
  while((m=re.exec(tpl))){
    if(m[4]) tokens.push({ type:"input", label:m[4].trim(), def:(m[5]??"").trim(), raw:m[0] });
    else tokens.push({ type:"select", label:m[2].trim(), options:m[3].split("|").map(s=>s.trim()).filter(Boolean), raw:m[0] });
  }
  return tokens;
}
function hasPlaceholders(tpl){ return /\{\{(select:|input:)/.test(tpl); }

// Snippet de mail?
function isMailSnippet(value){
  return value && typeof value === "object" && (value.subject || value.body);
}

// Escapes para preview HTML
function escapeHTML(s){
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

// Render con highlight
function renderFilled(tpl, valueMap, {highlight=false} = {}){
  const src = expandStaticMacros(tpl);
  const re = /\{\{(select:([^}|]+)\|[^}]+|input:([^}|]+)(?:\|[^}]*)?)\}\}/g;

  let plain = "", html = "";
  let lastIndex = 0, m;

  while ((m = re.exec(src))) {
    const before = src.slice(lastIndex, m.index);
    plain += before;
    html  += escapeHTML(before);

    const label = (m[2] || m[3] || "").trim();
    const val = valueMap[label] ?? "";

    plain += val;
    html  += highlight ? `<span class="hl" data-label="${escapeHTML(label)}">${escapeHTML(val)}</span>` : escapeHTML(val);
    lastIndex = re.lastIndex;
  }
  const tail = src.slice(lastIndex);
  plain += tail;
  html  += escapeHTML(tail);

  plain = plain.replace(/\s+([,.;:!?])/g, "$1");
  html  = html.replace(/\s+([,.;:!?])(?![^<]*>)/g, "$1");
  return { plain, html };
}

/* ===== Eventos sintéticos para sincronizar con React/SPA ===== */
function emitInputLike(el){
  try {
    if (typeof InputEvent !== "undefined") {
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "" });
      el.dispatchEvent(bi);
    }
  } catch(_){}
  try {
    if (typeof InputEvent !== "undefined") {
      const ie = new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: "" });
      el.dispatchEvent(ie);
    } else {
      const ev = new Event("input", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    }
  } catch(_) {
    try {
      const ev = new Event("input", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    } catch(__) {}
  }
  try {
    const ce = new Event("change", { bubbles: true, cancelable: true });
    el.dispatchEvent(ce);
  } catch(_){}
}
function getEditableRootFromNode(node){
  let el = (node && node.nodeType === Node.ELEMENT_NODE) ? node : node?.parentElement;
  while (el && !el.isContentEditable) el = el.parentElement;
  return el || document.activeElement || document.body;
}

/* ========================== Detección & reemplazo de atajos ========================== */
function findShortcutInInput(el){
  const start=el.selectionStart, end=el.selectionEnd, text=el.value;
  const left=text.slice(0,start).replace(/\s+$/,"");
  let last=null,m; while((m=RE_SHORTCUT_NEAR_CARET.exec(left))!==null) last=m; RE_SHORTCUT_NEAR_CARET.lastIndex=0;
  if(!last) return null;
  return { kind:"input", el, original:text, right:text.slice(end), from:last.index, to:last.index+last[0].length, shortcut:last[0] };
}
function insertAtInput(ctx, finalText){
  const before=ctx.original.slice(0,ctx.from), after=ctx.original.slice(ctx.to)+ctx.right;
  ctx.el.value = before + finalText + after;
  const caret=(before+finalText).length; ctx.el.setSelectionRange(caret,caret);
  emitInputLike(ctx.el);
}

function findShortcutInEditable(){
  const sel=window.getSelection(); if(!sel||!sel.rangeCount) return null;
  const caret=sel.getRangeAt(0), probe=caret.cloneRange(); probe.collapse(true); probe.setStart(probe.startContainer,0);
  const left=probe.toString().replace(/\s+$/,"");
  let last=null,m; while((m=RE_SHORTCUT_NEAR_CARET.exec(left))!==null) last=m; RE_SHORTCUT_NEAR_CARET.lastIndex=0;
  if(!last) return null;

  const shortcut=last[0], del=caret.cloneRange(); let node=caret.startContainer, off=caret.startOffset, remain=shortcut.length;

  function prevTextNodeIter(n){
    function prev(x){
      if(!x) return null;
      if(x.previousSibling){
        x = x.previousSibling;
        while(x && x.lastChild) x = x.lastChild;
        return x;
      }
      return prev(x.parentNode);
    }
    let p = prev(n);
    while(p && p.nodeType!==Node.TEXT_NODE) p = prev(p);
    return p;
  }

  while(remain>0 && node){
    if(node.nodeType===Node.TEXT_NODE){
      const take=Math.min(off,remain);
      del.setStart(node,off-take);
      remain-=take; if(remain===0) break;
    }
    const prev=prevTextNodeIter(node); if(!prev) break; node=prev; off=node.textContent.length;
  }
  return { kind:"editable", sel, del, shortcut };
}
function insertAtEditable(ctx, finalText){
  ctx.del.deleteContents();
  const tn=document.createTextNode(finalText);
  ctx.del.insertNode(tn);
  ctx.sel.removeAllRanges();
  const r=document.createRange();
  r.setStart(tn,finalText.length); r.setEnd(tn,finalText.length);
  ctx.sel.addRange(r);
  const root = getEditableRootFromNode(tn);
  emitInputLike(root);
}


/* === Helper v4 (anclado en ctx.del): Reemplaza TODO lo previo al caret por finalText sin depender de la selección activa (dialog) === */
function replaceBeforeCaret(ctx, finalText){
  // INPUT/TEXTAREA
  try{
    if (ctx && ctx.kind === "input" && ctx.el) {
      const el = ctx.el;
      const caret = Number(el.selectionStart || 0);
      const after = String(el.value || "").slice(caret);
      el.value = String(finalText) + after;
      const pos = String(finalText).length;
      try { el.setSelectionRange(pos, pos); } catch(_){}
      emitInputLike(el);
      return;
    }
  }catch(_){}

  // CONTENTEDITABLE usando el rango original (ctx.del) como ancla
  try{
    if (!ctx || ctx.kind !== "editable" || !ctx.del) return;
    const root = getEditableRootFromNode(ctx.del.startContainer) || document.activeElement || document.body;
    if (!root.contains(ctx.del.startContainer)) return;

    // Insertamos un marcador en el punto exacto donde estaba "maf"
    const marker = document.createElement("span");
    marker.setAttribute("data-maf-anchor","1");
    marker.style.cssText = "display:inline-block;width:0;height:0;overflow:hidden;";
    try { ctx.del.insertNode(marker); } catch(_){ return; }

    // Borramos TODO lo anterior al marcador dentro del root editable
    const wipe = document.createRange();
    wipe.setStart(root, 0);
    try { wipe.setEndBefore(marker); } catch(_){ wipe.setEnd(root, 0); }
    wipe.deleteContents();

    // Reemplazamos el marcador por el texto final
    const tn = document.createTextNode(String(finalText));
    marker.replaceWith(tn);

    // Dejamos el caret al final
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStart(tn, tn.length); r.setEnd(tn, tn.length);
      sel.removeAllRanges(); sel.addRange(r);
    }

    emitInputLike(root);
  }catch(_){}
}
/* ========================== UI: diálogo de placeholders ========================== */
const ML={yellow:"#FFE600",blue:"#3483FA",border:"#E6E6E6",dark:"#333"};
let shadowHost=null, dialogOpen=false;

function ensureDialog(){
  if(shadowHost) return shadowHost;
  shadowHost=document.createElement("div");
  shadowHost.style.position="fixed"; shadowHost.style.inset="0"; shadowHost.style.zIndex="2147483647";
  const shadow=shadowHost.attachShadow({mode:"open"}); document.documentElement.appendChild(shadowHost);

  shadow.innerHTML=`
    <style>
      :host { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      dialog{ border:none; border-radius:16px; padding:16px; width:min(780px,94vw); }
      dialog::backdrop{ background:rgba(0,0,0,.25); }
      .hdr{ display:flex; align-items:center; gap:10px; margin-bottom:10px }
      .pill{ width:12px; height:28px; border-radius:8px; background:${ML.yellow}; box-shadow:0 0 0 3px rgba(255,230,0,.35) }
      h3{ margin:0; font-size:16px; font-weight:800; color:${ML.dark} }
      .wrap{ display:grid; grid-template-columns:280px 1fr; gap:14px }
      .left{ border:1px solid ${ML.border}; border-radius:12px; padding:10px; max-height:70vh; overflow:auto; background:#fff }
      .field{ display:flex; flex-direction:column; gap:6px; margin-bottom:10px }
      label{ font-size:12px; color:#555 }
      input, select{ padding:10px 12px; border:1px solid ${ML.border}; border-radius:10px; font-size:14px; outline:none; background:#fff }
      input:focus, select:focus{ border-color:${ML.blue}; box-shadow:0 0 0 3px rgba(52,131,250,.12) }
      .prevCard{ border:1px solid ${ML.border}; border-radius:12px; padding:10px; background:#fff; display:flex; flex-direction:column; gap:8px }
      .prev{ white-space:pre-wrap; overflow:auto; min-height:180px; max-height:44vh }
      .prev .hl{ background:#FFF59D; border-radius:4px; padding:0 2px; }
      .actions{ display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:12px }
      .btnRow{ display:flex; gap:8px }
      .btn{ border-radius:10px; padding:9px 14px; font-weight:800; cursor:pointer; font-size:13px }
      .btn:focus-visible{ outline:2px solid ${ML.blue}; outline-offset:2px }
      .ok{ background:${ML.blue}; color:#fff; border:none }
      .cancel{ background:#fff; color:${ML.blue}; border:1px solid ${ML.blue} }
      .ghost{ background:#fff; color:#333; border:1px solid ${ML.border} }
      .hint{ font-size:12px; color:#666 }
      @media (max-width:640px){ .wrap{ grid-template-columns:1fr } }
      .toast{ position:fixed; bottom:18px; right:18px; background:#1f2937; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px; opacity:.98 }
    </style>
    <dialog role="dialog" aria-modal="true" aria-label="Completar plantilla">
      <div class="hdr"><div class="pill"></div><h3>Completar plantilla</h3></div>
      <div class="wrap">
        <div class="left" id="fields"></div>
        <div class="prevCard">
          <div class="prev" id="prev" contenteditable="true"></div>
          <div class="actions">
            <span class="hint">Podés editar la vista previa antes de insertar.</span>
            <div class="btnRow">
              <button class="btn ghost" id="copy">Copiar</button>
              <button class="btn cancel" id="cancel">Cancelar</button>
              <button class="btn ok" id="ok">Insertar</button>
            </div>
          </div>
        </div>
      </div>
    </dialog>
    <div id="toast" class="toast" style="display:none"></div>
  `;
  return shadowHost;
}

function showToast(msg){
  const t = shadowHost.shadowRoot.querySelector("#toast");
  t.textContent = msg; t.style.display="block";
  clearTimeout(showToast._t); showToast._t = setTimeout(()=>{ t.style.display="none"; }, 1600);
}

/* ===== chrome.storage helpers ===== */
function storageGetLocal(key, def=null){
  return new Promise(resolve=>{
    try{
      chrome.storage?.local?.get({[key]: def}, obj => {
        if (chrome.runtime?.lastError) { resolve(def); return; }
        resolve(obj?.[key] ?? def);
      });
    }catch(_){ resolve(def); }
  });
}
function storageSetLocal(obj){
  try{ chrome.storage?.local?.set(obj,()=>{});}catch(_){}
}
function storageGetSession(key, def=null){
  return new Promise(resolve=>{
    try{
      chrome.storage?.session?.get?.(key, obj => {
        if (chrome.runtime?.lastError) { resolve(def); return; }
        const v = (obj && (key in obj)) ? obj[key] : def;
        resolve(v);
      });
    }catch(_){ resolve(def); }
  });
}
async function storageGetSafe(key, def=null){
  const v1 = await storageGetSession(key, undefined);
  if (v1 !== undefined && v1 !== null) return v1;
  return storageGetLocal(key, def);
}

/* ===== Guarda/lee últimos valores por atajo ===== */
async function getLastValues(shortcut){
  return storageGetLocal(`fx:last:${shortcut}`, null);
}
function setLastValues(shortcut, values){
  storageSetLocal({[`fx:last:${shortcut}`]: values});
}

/* ===== Abre el diálogo, devuelve string final o null ===== */
async function openDialog(tpl, shortcut){
  ensureDialog();
  const sh = shadowHost.shadowRoot;
  const dlg = sh.querySelector("dialog");
  const fields = sh.querySelector("#fields");
  const prev = sh.querySelector("#prev");
  const ok = sh.querySelector("#ok");
  const cancel = sh.querySelector("#cancel");
  const copyBtn = sh.querySelector("#copy");

  const tokens = parsePlaceholders(tpl);
  const last = await getLastValues(shortcut);

  // Unificar por etiqueta
  const seen = new Map();
  const state = [];
  for (const t of tokens) {
    const key = `${t.type}::${t.label}`;
    if (seen.has(key)) continue;
    const value = (last && last[t.label] !== undefined)
      ? last[t.label]
      : (t.type==="select" ? (t.options?.[0] || "") : (t.def || ""));
    state.push({ type: t.type, label: t.label, options: t.options, raw: t.raw, value });
    seen.set(key, true);
  }

  function renderPrev(){
    const valueMap = {};
    for (const s of state) valueMap[s.label] = s.value ?? "";
    const { plain, html } = renderFilled(tpl, valueMap, {highlight:true});
    if (!prev.hasAttribute("data-manual")) {
      prev.innerHTML = html;
      prev.dataset.plain = plain;
    }
  }

  fields.innerHTML="";
  state.forEach(s=>{
    const w=document.createElement("div"); w.className="field";
    const lab=document.createElement("label"); lab.textContent=s.label; w.appendChild(lab);
    if(s.type==="select"){
      const sel=document.createElement("select");
      (s.options||[]).forEach(o=>{ const op=document.createElement("option"); op.value=o; op.textContent=o; sel.appendChild(op); });
      sel.value=s.value;
      const onSel = ()=>{ s.value=sel.value; prev.removeAttribute("data-manual"); renderPrev(); };
      sel.addEventListener("input", onSel);
      sel.addEventListener("change", onSel);
      w.appendChild(sel);
    }else{
      const inp=document.createElement("input"); inp.type="text"; inp.placeholder=s.label; inp.value=s.value||"";
      inp.addEventListener("input",()=>{ s.value=inp.value; prev.removeAttribute("data-manual"); renderPrev(); });
      w.appendChild(inp);
    }
    fields.appendChild(w);
  });

  prev.textContent=""; prev.removeAttribute("data-manual");
  prev.addEventListener("input",()=>prev.setAttribute("data-manual","1"));
  renderPrev();

  let resolvePromise;
  let internalClose = false;

  const ac = new AbortController();
  const { signal } = ac;

  const done = (val)=>{
    try { internalClose = true; dlg.close(); } catch(_){}
    if (shadowHost?.isConnected) shadowHost.style.display="none";
    dialogOpen=false;
    ac.abort();
    resolvePromise?.(val);
  };

  const trapDoc = (e)=>{
    if (!dialogOpen) return;
    if (shadowHost && shadowHost.contains(e.target)) return;
    e.stopPropagation();
  };
  document.addEventListener("keydown", trapDoc, { capture:true, signal });
  document.addEventListener("input",  trapDoc, { capture:true, signal });

  dlg.addEventListener("cancel", (e)=>{ e.preventDefault(); }, { signal });
  dlg.addEventListener("close", () => {
    if (dialogOpen && !internalClose) {
      try { dlg.showModal(); } catch(_){}
    }
  }, { signal });

  copyBtn.onclick = async ()=>{
    const plain = prev.dataset.plain || prev.textContent || "";
    try { await navigator.clipboard.writeText(plain); showToast("Copiado ✅"); done(null); }
    catch(_){ try{ const ta=document.createElement("textarea"); ta.value=plain; ta.style.position="fixed"; ta.style.opacity="0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); showToast("Copiado ✅"); done(null);}catch(__){ showToast("No se pudo copiar"); } }
  };
  ok.onclick = ()=> {
    const map = {}; state.forEach(s=> map[s.label]=s.value);
    setLastValues(shortcut, map);
    const plain = prev.dataset.plain || prev.textContent || "";
    done(plain);
  };
  cancel.onclick = ()=> done(null);

  shadowHost.style.display="block"; dialogOpen=true;
  dlg.showModal();

  const focusables = sh.querySelectorAll("button, [href], input, select, [contenteditable='true']");
  (focusables[0] || ok).focus();

  return new Promise(res => (resolvePromise = res));
}

/* ==========================
   Typeahead de atajos (/...)
========================== */
let taHost = null;
let taOpen = false;
let taSelIdx = -1;
let taItems = [];
let taTarget = null;
let taCtxLast = null;

function ensureTypeahead(){
  if (taHost) return taHost;
  taHost = document.createElement("div");
  taHost.style.position = "fixed";
  taHost.style.zIndex = "2147483646";
  const sh = taHost.attachShadow({mode:"open"});
  sh.innerHTML = `
    <style>
      .box{
        min-width: 220px; max-width: 360px;
        background: #fff;
        border: 1px solid #E6E6E6; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,.08);
        font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        overflow: hidden;
      }
      .item{ padding: 8px 10px; cursor: pointer; display:flex; gap:8px; align-items:center; }
      .item:hover, .item.active{ background: #F2F6FF; }
      .kbd{ font-size:11px; color:#999; }
      .empty{ padding:8px 10px; color:#777; }
    </style>
    <div class="box" id="box" hidden></div>
  `;
  document.documentElement.appendChild(taHost);
  return taHost;
}

function hideTypeahead(){
  if (!taHost) return;
  const sh = taHost.shadowRoot;
  const box = sh.getElementById("box");
  box.hidden = true;
  taOpen = false;
  taSelIdx = -1;
  taItems = [];
  taTarget = null;
}

function renderTypeahead(items, anchorRect){
  ensureTypeahead();
  const sh = taHost.shadowRoot;
  const box = sh.getElementById("box");

  const top = Math.round((anchorRect.bottom || (anchorRect.top + 20)) + 6 + scrollY);
  const left = Math.round((anchorRect.left || 16) + scrollX);
  taHost.style.top = `${top}px`;
  taHost.style.left = `${left}px`;

  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="empty">Sin resultados</div>`;
  } else {
    items.forEach((k, i) => {
      const div = document.createElement("div");
      div.className = "item" + (i === taSelIdx ? " active" : "");
      div.innerHTML = `<span class="kbd">${i<9 ? (i+1)+'.' : '&bull;'}</span> <span>${k}</span>`;

      const handler = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        selectTypeahead(i);
      };
      div.addEventListener("pointerdown", handler);
      div.addEventListener("mousedown", handler);
      div.addEventListener("click", handler);

      box.appendChild(div);
    });
  }

  box.hidden = false;
  taOpen = true;
}

function filterSnippets(prefix){
  const q = String(prefix).toLowerCase();
  const starts = snipKeysOriginal.filter(k => k.toLowerCase().startsWith(q));
  const contains = snipKeysOriginal.filter(k => !k.toLowerCase().startsWith(q) && k.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0,7);
}

function currentAnchorRect(target){
  try {
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      return target.getBoundingClientRect();
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).cloneRange();
      const rect = r.getClientRects()[0] || r.getBoundingClientRect();
      if (rect && rect.width) return rect;
    }
  } catch(_) {}
  return (target?.getBoundingClientRect?.()) || { top: 20, bottom: 40, left: 20 };
}

function selectTypeahead(idx){
  if (!taOpen || idx<0 || idx>=taItems.length) return;
  const chosen = taItems[idx];
  const t = taTarget;
  if (!t) { hideTypeahead(); return; }

  const ctx = taCtxLast || ((t.value!==undefined) ? findShortcutInInput(t) : findShortcutInEditable());
  if (!ctx) { hideTypeahead(); return; }

  const finalText = chosen;
  if (ctx.kind === "input") {
    const before=ctx.original.slice(0,ctx.from), after=ctx.original.slice(ctx.to)+ctx.right;
    t.value = before + finalText + after;
    const caret=(before+finalText).length; t.setSelectionRange(caret,caret);
  } else {
    ctx.del.deleteContents();
    const tn=document.createTextNode(finalText);
    ctx.del.insertNode(tn);
    ctx.sel.removeAllRanges();
    const r=document.createRange();
    r.setStart(tn,finalText.length); r.setEnd(tn,finalText.length);
    ctx.sel.addRange(r);
  }

  try {
    const ev = new Event("input", { bubbles:true, cancelable:true });
    t.dispatchEvent(ev);
  } catch(_){}

  taCtxLast = null;
  hideTypeahead();
}

function handleTypeaheadKey(e){
  if (!taOpen) return false;
  if (e.key === "ArrowDown") { taSelIdx = Math.min(taSelIdx+1, taItems.length-1); }
  else if (e.key === "ArrowUp") { taSelIdx = Math.max(taSelIdx-1, 0); }
  else if (e.key === "Enter" || e.key === "Tab") { selectTypeahead(taSelIdx>=0?taSelIdx:0); return true; }
  else if (e.key >= "1" && e <= "9") { const i = parseInt(e.key,10)-1; if (i < taItems.length) { selectTypeahead(i); return true; } }
  else if (e.key === "Escape") { hideTypeahead(); return true; }
  renderTypeahead(taItems, currentAnchorRect(taTarget));
  return ["ArrowDown","ArrowUp","Enter","Tab","Escape"].includes(e.key) || (/^[1-9]$/.test(e.key));
}

/* ========================== Handler principal ========================== */
function isEditableTarget(t){
  if(!t) return false;
  if (t.tagName === "TEXTAREA") return true;
  if (t.tagName === "INPUT") {
    const ok = new Set(["text","search","url","email","tel","password"]);
    return ok.has(t.type || "text");
  }
  return t.isContentEditable;
}
function shouldTrigger(e){
  if (e.isComposing) return false;
  if (e.type === "keydown" && e.repeat) return false;
  if (e.type==="keydown" && e.ctrlKey && e.key===" ") return true;
  return e.key===" " || e.key==="Enter" || e.key==="Tab" || e.type==="input";
}

/* ==== helpers para completar mails (Gmail / Outlook Web) ==== */
function findEmailFields() {
  const d = document;
  const gmailSubject = d.querySelector('input[name="subjectbox"]') || d.querySelector('input[aria-label="Subject"]') || d.querySelector('textarea[aria-label="Subject"]') || d.querySelector('input[aria-label="Asunto"]') || d.querySelector('textarea[aria-label="Asunto"]');
  const gmailBody    = d.querySelector('div[aria-label="Message Body"]') || d.querySelector('div[aria-label="Cuerpo del mensaje"]') || d.querySelector('div[role="textbox"][g_editable="true"]');
  const outlookSubject = d.querySelector('input[aria-label="Add a subject"]') || d.querySelector('input[aria-label="Asunto"]');
  const outlookBody    = d.querySelector('div[aria-label="Message body"]') || d.querySelector('div[aria-label="Cuerpo del mensaje"]') || d.querySelector('div[role="textbox"][contenteditable="true"]');
  const subjectEl = gmailSubject || outlookSubject || null;
  const bodyEl    = gmailBody    || outlookBody    || null;
  return { subjectEl, bodyEl };
}
function setInputValue(el, value) {
  if (!el) return;
  el.focus();
  if ('value' in el) { el.value = value; emitInputLike(el); }
  else { el.innerHTML = ''; el.insertAdjacentHTML('afterbegin', String(value).replace(/\n/g, '<br>')); emitInputLike(el); }
}
function tryFillEmail(subjectText, bodyText) {
  const { subjectEl, bodyEl } = findEmailFields();
  if (!subjectEl && !bodyEl) return false;
  if (subjectEl) setInputValue(subjectEl, subjectText);
  if (bodyEl) setInputValue(bodyEl, bodyText);
  return true;
}

document.addEventListener("keydown", onEvent, true);
document.addEventListener("keyup", onEvent, true);
document.addEventListener("input", onEvent, true);

async function onEvent(e){
  if(dialogOpen) return;

  if (taOpen) {
    const consumed = handleTypeaheadKey(e);
    if (consumed) { e.preventDefault?.(); e.stopPropagation?.(); return; }
  }

  const t=e.target;
  if(!isEditableTarget(t)) return;
  if(!shouldTrigger(e)) return;

  // 0) Asistente "maf": si detecto el token, manejo acá y corto
  if (e.key === " " || e.key === "Enter" || e.key === "Tab" || (e.type==="keydown" && e.ctrlKey && e.key===" ")) {
    if (maybeHandleMaf(e)) { 
      e.preventDefault?.(); 
      e.stopPropagation?.(); 
      return; 
    }
  }

  // ----- flujo de snippets -----
  const ctx = (t.value!==undefined) ? findShortcutInInput(t) : findShortcutInEditable();
  if(!ctx) { hideTypeahead(); return; }

  // Typeahead
  if (!dialogOpen && ctx && ctx.shortcut) {
    const prefix = String(ctx.shortcut);
    taTarget = t;

    if (!prefix.startsWith("/") || prefix.length < 2) {
      hideTypeahead();
    } else {
      const matches = filterSnippets(prefix.toLowerCase());
      taItems = matches;
      if (matches.length) {
        taSelIdx = 0;
        taCtxLast = ctx;
        renderTypeahead(matches, currentAnchorRect(t));
      } else {
        hideTypeahead();
      }
    }
  }

  if(e.key===" "||e.key==="Enter"||e.key==="Tab"){ e.preventDefault?.(); e.stopPropagation?.(); }

  const tplRaw = snipIndex.get(String(ctx.shortcut).toLowerCase());
  if(!tplRaw) return;

  hideTypeahead();

  /* ===== Snippet de MAIL {subject, body} ===== */
  if (isMailSnippet(tplRaw)) {
    const subjTpl = String(tplRaw.subject || "");
    const bodyTpl = String(tplRaw.body || "");
    const hasPh = hasPlaceholders(subjTpl) || hasPlaceholders(bodyTpl);

    if (!hasPh) {
      const subjectFinal = expandStaticMacros(subjTpl);
      const bodyFinal    = expandStaticMacros(bodyTpl);
      const filled = tryFillEmail(subjectFinal, bodyFinal);
      if (!filled) {
        const fallback = `ASUNTO: ${subjectFinal}\n\n${bodyFinal}`;
        if(ctx.kind==="input") insertAtInput(ctx, fallback); else insertAtEditable(ctx, fallback);
      }
      toastQuick("Mail completado ✅");
      return;
    } else {
      const SEP = "\n<<<__MAILSEP__>>>\n";
      const composite = subjTpl + SEP + bodyTpl;
      const finalComposite = await openDialog(composite, ctx.shortcut);
      if (finalComposite == null) return;

      const parts = String(finalComposite).split(SEP);
      const subjectFinal = (parts[0] || "").trim();
      const bodyFinal    = (parts.slice(1).join(SEP) || "").trim();

      const filled = tryFillEmail(subjectFinal, bodyFinal);
      if (!filled) {
        const fallback = `ASUNTO: ${subjectFinal}\n\n${bodyFinal}`;
        if(ctx.kind==="input") insertAtInput(ctx, fallback); else insertAtEditable(ctx, fallback);
      }
      toastQuick("Mail completado ✅");
      return;
    }
  }

  /* ===== Caso normal (string) ===== */
  if(!hasPlaceholders(tplRaw)){
    const final = expandStaticMacros(tplRaw);
    if(ctx.kind==="input") insertAtInput(ctx, final); else insertAtEditable(ctx, final);
    toastQuick("Snippet insertado ✅");
    return;
  }

  const finalText = await openDialog(tplRaw, ctx.shortcut);
  if(finalText == null) return;
  if(ctx.kind==="input") insertAtInput(ctx, finalText); else insertAtEditable(ctx, finalText);
  toastQuick("Snippet insertado ✅");
}

/* ========================== Util: toast rápido ========================== */
function toastQuick(msg){
  try{ const d=document.createElement("div");
    d.textContent=msg; d.style.cssText="position:fixed;bottom:18px;right:18px;background:#1f2937;color:#fff;padding:10px 14px;border-radius:10px;font-size:13px;z-index:2147483647;opacity:.98";
    document.body.appendChild(d); setTimeout(()=>d.remove(),1500);
  }catch(_){}
}

/* ========================== Estabilidad & Limpieza ========================== */
function cleanupAll(){
  hideTypeahead();
  if (shadowHost?.isConnected) { try { shadowHost.remove(); } catch(_) {} }
  dialogOpen = false;
}
addEventListener("pagehide", cleanupAll);

function attachCoreListeners(){
  document.addEventListener("keydown", onEvent, true);
  document.addEventListener("keyup", onEvent, true);
  document.addEventListener("input", onEvent, true);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") attachCoreListeners();
});
addEventListener("pageshow", () => {
  attachCoreListeners();
  dialogOpen = false;
});
addEventListener("popstate", attachCoreListeners);
addEventListener("hashchange", attachCoreListeners);
addEventListener("focus", attachCoreListeners);

/* ===================================================================== */
/* =================== Detección de "Nombre del challenge" ==============*/
/* ===================================================================== */

const RE_CHALLENGE = /\b(backoffice_[a-z0-9_]+)(?=$|\s|[^\w])/i;
function cleanChallengeToken(val){ return val ? String(val).trim().replace(/fecha$/i, '') : val; }
function publishDetectedChallenge(value){
  const v = value ? String(value).toLowerCase() : null;
  try { chrome.runtime?.sendMessage?.({ type: "maf:set_challenge", value: v }); console.log("[Mafalda] challenge detectado:", v); }
  catch(e){ console.warn("[Mafalda] no pude enviar a background:", e); }
}
let mafChallengeObserver=null, mafScanTimer=null, mafCurrentChallenge=null;
function findLabelNode() {
  const nodes = document.querySelectorAll("span,div,p,strong,h1,h2,h3,label");
  for (const el of nodes) {
    const t = el.textContent || "";
    if (t && /nombre\s+del\s+challenge|challenge\s*name/i.test(t)) return el;
  }
  return null;
}
function extractFromNode(el) {
  if (!el) return null;
  let m = (el.textContent || "").match(RE_CHALLENGE); if (m) return cleanChallengeToken(m[1]);
  const bold = el.querySelector("strong,b"); if (bold){ m = (bold.textContent || "").match(RE_CHALLENGE); if (m) return cleanChallengeToken(m[1]); }
  let sib = el.nextElementSibling;
  for (let i=0;i<3 && sib;i++, sib=sib.nextElementSibling){ m = (sib.textContent || "").match(RE_CHALLENGE); if (m) return cleanChallengeToken(m[1]); }
  const box = el.closest(".challenge-infos, .challenge-main-infos, section, article, div") || el;
  m = (box.innerText || "").match(RE_CHALLENGE); if (m) return cleanChallengeToken(m[1]);
  return null;
}
function fallbackScan() {
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  while (tw.nextNode()) {
    const t = tw.currentNode.nodeValue;
    const m = t && t.match(RE_CHALLENGE);
    if (m) return cleanChallengeToken(m[1]);
  }
  return null;
}
function findChallengeOnce(){ const labelEl = findLabelNode(); return extractFromNode(labelEl) || fallbackScan(); }
function updateChallenge(){
  try{
    const found = findChallengeOnce();
    if (found && found !== mafCurrentChallenge){
      mafCurrentChallenge = found.toLowerCase();
      publishDetectedChallenge(mafCurrentChallenge);
    }
  }catch(_){}
}
function ensureChallengeObserver(){
  if (mafChallengeObserver) return;
  updateChallenge();
  mafChallengeObserver = new MutationObserver(() => {
    clearTimeout(mafScanTimer);
    mafScanTimer = setTimeout(updateChallenge, 200);
  });
  mafChallengeObserver.observe(document.documentElement, { subtree:true, childList:true, characterData:true });
  addEventListener("hashchange", updateChallenge);
  addEventListener("popstate", updateChallenge);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateChallenge();
  });
}
ensureChallengeObserver();

/* ===================================================================== */
/* =================== Detección de SITE (país: MLA/MLB/…) ==============*/
/* ===================================================================== */

const RE_SITE = /\b(MLA|MLB|MLM|MLC|MCO|MPE|MLU|MLV)\b/;
function publishDetectedSite(value){
  const v = value ? String(value).toUpperCase() : null;
  try { chrome.runtime?.sendMessage?.({ type: "maf:set_site", value: v }); console.log("[Mafalda] site detectado:", v); }
  catch(e){ console.warn("[Mafalda] no pude enviar site a background:", e); }
}
let mafSiteObserver=null, mafSiteScanTimer=null, mafCurrentSite=null;
function findSiteOnce(){
  const nodes = document.querySelectorAll("h1,h2,h3,.page-title,.header,header,nav,div,span,strong");
  for (const el of nodes) {
    const txt = el.textContent || "";
    const m = txt.match(RE_SITE);
    if (m) return m[1];
  }
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  while (tw.nextNode()) {
    const t = tw.currentNode.nodeValue || "";
    const m = t.match(RE_SITE);
    if (m) return m[1];
  }
  return null;
}
function updateSite(){
  try{
    const found = findSiteOnce();
    if (found && found !== mafCurrentSite){
      mafCurrentSite = found;
      publishDetectedSite(mafCurrentSite);
    }
  }catch(_){}
}
function ensureSiteObserver(){
  if (mafSiteObserver) return;
  updateSite();
  mafSiteObserver = new MutationObserver(() => {
    clearTimeout(mafSiteScanTimer);
    mafSiteScanTimer = setTimeout(updateSite, 200);
  });
  mafSiteObserver.observe(document.documentElement, { subtree:true, childList:true, characterData:true });
  addEventListener("hashchange", updateSite);
  addEventListener("popstate", updateSite);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateSite();
  });
}
ensureSiteObserver();

/* ===================================================================== */
/* ======================= Gatillo "maf" + Panel IA ====================== */
/* ===================================================================== */

/** Detecta el token "maf" en <input>/<textarea> y devuelve contexto */
function findMafInInput(el){
  const s = el.selectionStart, e = el.selectionEnd, txt = el.value;
  const left = txt.slice(0, s).replace(/\s+$/,"");
  let last = null, m; const re = /\bmaf(?=\s|$)/ig;
  while((m = re.exec(left)) !== null) last = m;
  if(!last) return null;
  return {
    kind: "input",
    el,
    original: txt,
    right: txt.slice(e),
    from: last.index,
    to: last.index + 3, // "maf"
    beforeText: txt.slice(0, last.index).trim()
  };
}

/** Igual que arriba pero para contenteditable */
function findMafInEditable(){
  const sel = window.getSelection(); if(!sel || !sel.rangeCount) return null;
  const caret = sel.getRangeAt(0);
  const probe = caret.cloneRange(); probe.collapse(true); probe.setStart(probe.startContainer, 0);
  const left = probe.toString().replace(/\s+$/,"");
  const idx = left.toLowerCase().lastIndexOf("maf");
  if (idx < 0 || !/\bmaf$/i.test(left.slice(0, idx + 3))) return null;

  const del = caret.cloneRange();
  let node = caret.startContainer, off = caret.startOffset, remain = 3;

  function prevTextNodeIter(n){
    function prev(x){ if(!x) return null; if(x.previousSibling){ x = x.previousSibling; while(x && x.lastChild) x = x.lastChild; return x; } return prev(x.parentNode); }
    let p = prev(n); while(p && p.nodeType !== Node.TEXT_NODE) p = prev(p); return p;
  }

  while(remain > 0 && node){
    if(node.nodeType === Node.TEXT_NODE){
      const take = Math.min(off, remain);
      del.setStart(node, off - take);
      remain -= take;
      if(remain === 0) break;
    }
    const prev = prevTextNodeIter(node); if(!prev) break;
    node = prev; off = node.textContent.length;
  }
  const beforeText = left.slice(0, idx).trim();
  return { kind:"editable", sel, del, beforeText };
}

/** Elimina el token "maf" y deja el caret listo para insertar */
function removeMafToken(ctx){
  if(ctx.kind === "input"){
    const before = ctx.original.slice(0, ctx.from);
    const after  = ctx.original.slice(ctx.to) + ctx.right;
    ctx.el.value = before + after;
    const caret = before.length;
    ctx.el.setSelectionRange(caret, caret);
    emitInputLike(ctx.el);
  } else {
    ctx.del.deleteContents();
    const tn = document.createTextNode("");
    ctx.del.insertNode(tn);
    ctx.sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(tn, 0); r.setEnd(tn, 0);
    ctx.sel.addRange(r);
    emitInputLike(getEditableRootFromNode(tn));
  }
}

/* === NUEVO: normalizador de URL de Apps Script === */
function normalizeAppsScriptUrl(u){
  if (!u) return u;
  return String(u).replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    "https://script.google.com/macros/s/"
  );
}

/* ========= NUEVO: Helpers para detectar PDFs en Checker ========= */
function absoluteUrl(url){
  try{ return new URL(url, location.href).toString(); } catch{ return url||""; }
}
function getRawSrc(el){ return el?.getAttribute?.("src") || el?.getAttribute?.("href") || ""; }
const __pad2 = (n)=> String(n).padStart(2,"0");

function normalizeToSecureUrl(raw){
  const abs = absoluteUrl(raw); if(!abs) return null;
  const lower = abs.toLowerCase();
  if (lower.includes("/api/iv/getpdf")) return abs;
  if (lower.startsWith("http://")) {
    return `https://kyc-checker.adminml.com/api/iv/getPdf?url=${encodeURIComponent(abs)}`;
  }
  if (lower.startsWith("https://") && /\.pdf(\?|$)/i.test(lower)) return abs;
  try{
    const u = new URL(abs);
    const alt = u.searchParams.get("url") || u.searchParams.get("doc") || u.searchParams.get("file");
    if (alt) return normalizeToSecureUrl(alt);
  }catch{}
  return `https://kyc-checker.adminml.com/api/iv/getPdf?url=${encodeURIComponent(abs)}`;
}

function detectCaseId(){
  const m = location.pathname.match(/\/case\/(\d+)/);
  if (m?.[1]) return m[1];
  const q = new URLSearchParams(location.search);
  const qp = q.get("case") || q.get("case_id") || q.get("challengeId") || q.get("id");
  if (qp && /^\d{6,15}$/.test(qp)) return qp;
  return "UNKNOWN";
}
function suggestFileName(raw, idx, caseId){
  try{
    const u = new URL(absoluteUrl(raw));
    const nameParam = u.searchParams.get("name");
    const base = nameParam || (u.pathname.split("/").pop() || "documento");
    const name = /\.pdf$/i.test(base) ? base : `${base}.pdf`;
    return `CASE_${caseId}__${__pad2(idx+1)}__${name}`;
  }catch{
    return `CASE_${caseId}__${__pad2(idx+1)}__documento.pdf`;
  }
}

function isPdfLikeEl(el){
  const type = (el.getAttribute?.("type") || "").toLowerCase();
  const raw  = getRawSrc(el); const src = (raw || "").toLowerCase();
  if (!raw) return false;
  if (src.includes("/api/iv/getpdf")) return true;
  if (src.includes("kyc-documents.adminml.com") && src.includes(".pdf")) return true;
  if (type.includes("application/pdf")) return true;
  const tag = el.tagName?.toLowerCase();
  if ((tag==="embed" || tag==="object") && (type.includes("pdf") || /\.pdf(\?|$)/i.test(src))) return true;
  if (tag==="iframe" && (src.includes("pdf") || src.includes("viewer") || src.includes("file="))) return true;
  return false;
}

function collectKycPdfTargets(){
  const caseId = detectCaseId();
  const els = Array.from(document.querySelectorAll("iframe,embed,object,a[href]"));
  const seen = new Set();
  const items = [];
  let idx = 0;
  for (const el of els){
    if (!isPdfLikeEl(el)) continue;
    const raw = getRawSrc(el);
    const url = normalizeToSecureUrl(raw);
    if (!url) continue;
    const key = url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ url, name: suggestFileName(raw, idx++, caseId) });
  }
  return items;
}

/** Llama al background para que haga el fetch a Apps Script (evita CORS)
 *  NUEVO: acepta objeto { text, site?, cdu?, attachments? }.
 */
async function analyzeWithAI(arg){
  // Compatibilidad: si vienen solo "freeText" (string), lo convertimos
  const payload = (typeof arg === "string") ? { text: arg } : (arg || {});
  const cdu  = await storageGetSafe("maf_challenge", null);
  const site = await storageGetSafe("maf_site", null);
  const remoteRaw = await storageGetLocal("remote_url", "");
  const remote = normalizeAppsScriptUrl(remoteRaw || "");
  if(!remote) throw new Error('Falta configurar la "Fuente remota" en el popup');

  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

  return await new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: "maf:ai_analyze",
          remoteUrl: remote,
          text: String(payload.text || ""),
          cdu: String(payload.cdu || cdu || ""),
          site: String(payload.site || site || ""),
          attachments
        },
        (res) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (!res || res.ok === false) return reject(new Error(res?.error || "No se pudo analizar el texto."));
          resolve(res.data);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

/** Panel con estilo Mafalda (similar al mock) */
function openMafPanel(freeText, ctxForInsert){
  const host = document.createElement("div");
  host.style.position="fixed"; host.style.inset="0"; host.style.zIndex="2147483647";
  const sh = host.attachShadow({mode:"open"});
  document.documentElement.appendChild(host);

  sh.innerHTML = `
    <style>
      :host{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
      dialog{border:none;border-radius:18px;width:min(920px,96vw);padding:0}
      dialog::backdrop{background:rgba(0,0,0,.25)}
      .wrap{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px}
      .col{display:flex;flex-direction:column;gap:12px}
      .card{background:#fff;border:1px solid #E6E6E6;border-radius:14px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
      .title{font-weight:800;margin-bottom:6px}
      .muted{color:#666;font-size:12px}
      .caseBox{min-height:120px;max-height:260px;overflow:auto;white-space:pre-wrap}
      .detectedBox{min-height:90px}
      .ok{color:#0a7b20;font-weight:700}
      .bad{color:#b00020;font-weight:700}
      .finalBox{min-height:260px;max-height:420px;overflow:auto;white-space:pre-wrap}
      .finalEdit[contenteditable="true"]{outline:none;border:1px dashed #E6E6E6;border-radius:10px;padding:10px;background:#fafafa}
      .row{display:flex;gap:8px;justify-content:flex-end}
      .btn{border-radius:10px;padding:9px 14px;font-weight:800;cursor:pointer;font-size:13px}
      .ghost{background:#fff;color:#333;border:1px solid #E6E6E6}
      .okbtn{background:#3483FA;color:#fff;border:none}
      .close{position:absolute;right:10px;top:10px;border:none;background:#fff;border-radius:8px;padding:6px 9px;cursor:pointer}
      .hdr{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #EFEFEF}
      .hdr h3{margin:0;font-size:16px}
      .spinner{display:inline-block;width:14px;height:14px;border:2px solid #ddd;border-top-color:#3483FA;border-radius:50%;animation:sp 1s linear infinite;margin-right:6px}
      @keyframes sp{to{transform:rotate(360deg)}}
    </style>
    <dialog>
      <div class="hdr">
        <h3>Asistente de respuesta</h3>
        <button class="close" title="Cerrar">✕</button>
      </div>
      <div class="wrap">
        <div class="col">
          <div class="card">
            <div class="title">Mensaje final al usuario</div>
            <div id="final" class="finalEdit finalBox" contenteditable="true">Generando recomendación…</div>
            <div class="row" style="margin-top:8px">
              <button id="copy" class="btn ghost">copiar</button>
              <button id="insert" class="btn okbtn">insertar</button>
            </div>
          </div>
        </div>
        <div class="col">
          <div class="card">
            <div class="title">Texto del caso</div>
            <div id="case" class="caseBox"></div>
          </div>
          <div class="card">
            <div class="title">Casuística detectada</div>
            <div id="detected" class="detectedBox"><span class="spinner"></span>Analizando…</div>
          </div>
        </div>
      </div>
    </dialog>
  `;

  const dlg       = sh.querySelector("dialog");
  const btnClose  = sh.querySelector(".close");
  const btnCopy   = sh.querySelector("#copy");
  const btnIns    = sh.querySelector("#insert");
  const caseEl    = sh.querySelector("#case");
  const detEl     = sh.querySelector("#detected");
  const finalEl   = sh.querySelector("#final");

  caseEl.textContent = freeText || "(vacío)";

  function close(){ try{ dlg.close(); }catch(_){ } host.remove(); }

  btnClose.onclick = close;
  btnCopy.onclick = async ()=>{ try{ await navigator.clipboard.writeText(finalEl.innerText || ""); }catch(_){ } };
  btnIns.onclick = () => { const clean = (finalEl.innerText || "").trim(); if (!clean) return; replaceBeforeCaret(ctxForInsert, clean); close(); };

  dlg.addEventListener("cancel", e=>e.preventDefault());
  dlg.showModal();

  (async ()=>{
    try{
      // 1) Detectar PDFs del caso (no descarga en browser)
      const attachments = collectKycPdfTargets(); // [{url,name}, ...]

      // 2) Llamar a IA pasando texto + attachments
      const res = await analyzeWithAI({ text: freeText, attachments });

      const ok = !!res.isAllowed;
      const items = Array.isArray(res.detected) ? res.detected : (res.detected ? [res.detected] : []);
      detEl.innerHTML = `
        <div>${items.length ? items.map(x=>`• ${escapeHTML(String(x))}`).join("<br>") : "—"}</div>
        <div style="margin-top:6px">${ok ? '<span class="ok">✔ Correcto</span>' : '<span class="bad">✖ Incorrecto</span>'}</div>
        <div style="margin-top:6px; font-size:12px; color:#555">
          Adjuntos enviados: ${attachments.length ? attachments.map(a=>escapeHTML(a.name)).join(", ") : "ninguno"}
        </div>
      `;
      if (res.improved) finalEl.textContent = res.improved;
      finalEl.focus();
    }catch(e){
      detEl.innerHTML = `<span class="bad">No se pudo analizar (${escapeHTML(String(e.message||e))})</span>`;
      finalEl.textContent = "No pude generar la recomendación en este momento. Revisá la guía y redactá el mensaje para el usuario.";
    }
  })();

  function escapeHTML(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");}
}

/** Hook al flujo de eventos existente: si aparece 'maf', abrimos el panel */
function maybeHandleMaf(e){
  const t = e.target;
  if (!isEditableTarget(t)) return false;

  const ctx = (t.value !== undefined) ? findMafInInput(t) : findMafInEditable();
  if (!ctx) return false;

  const freeText = ctx.beforeText || "";
  removeMafToken(ctx);
  openMafPanel(freeText, ctx);
  return true;
}

