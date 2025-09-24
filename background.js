// background.js — MV3 service worker (FINAL)
// - Proxy hacia Apps Script con cookies corporativas (evita CORS)
// - Envía texto + site + cdu + attachments [{url,name}] (no binarios)
// - Mantiene helpers de contexto (opcional)

const DEFAULT_TIMEOUT_MS = 60_000;

/** Normaliza URL del Web App de Apps Script */
function normalizeAppsScriptUrl(u) {
  if (!u) return "";
  return String(u).replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    "https://script.google.com/macros/s/"
  );
}

/** POST sin preflight y con timeout (usa text/plain) */
async function postWithCookies(url, bodyObj, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  // text/plain evita preflight; el servidor parsea JSON igual
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",                 // importante para dominios internos / SSO
    cache: "no-store",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(bodyObj || {}),
    signal: ctrl.signal
  }).catch((e) => {
    clearTimeout(t);
    throw e;
  });

  clearTimeout(t);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} – ${text.slice(0, 300) || "error"}`);
  }

  let data = null;
  try { data = JSON.parse(text); }
  catch { throw new Error("La respuesta del Apps Script no es JSON válido"); }

  return data;
}

/** Sanitiza la lista de adjuntos [{url,name}] */
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it.url !== "string") continue;
    const url = String(it.url).trim();
    if (!url) continue;
    const name = String(it.name || "documento.pdf");
    out.push({ url, name });
    if (out.length >= 12) break; // límite de seguridad
  }
  return out;
}

// === Mensajería desde content/popup ===
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // 1) Proxy de análisis IA (ahora con attachments)
  if (msg.type === "maf:ai_analyze") {
    (async () => {
      try {
        const remote = normalizeAppsScriptUrl(msg.remoteUrl || "");
        if (!remote) throw new Error('Falta configurar la "Fuente remota" (URL del Web App).');

        // Sanitizamos entradas
        const text = String(msg.text || "");
        const cdu  = (msg.cdu == null) ? "" : String(msg.cdu);
        const site = (msg.site == null) ? "" : String(msg.site);
        const attachments = sanitizeAttachments(msg.attachments);

        const payload = {
          op: "analyze",
          text,
          cdu,
          site,
          attachments // << URLs y nombres; Apps Script descarga y hace OCR
        };

        const data = await postWithCookies(remote, payload);

        if (!data || data.ok === false) {
          throw new Error(data?.error || "No se pudo analizar.");
        }
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();

    return true; // mantener el canal abierto (async)
  }

  // 2) (Opcional) Guardar contexto detectado
  if (msg.type === "maf:set_context") {
    chrome.storage.session.set({
      maf_cdu: msg.cdu ?? null,
      maf_site: msg.site ?? null
    }).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // 3) (Opcional) Leer contexto
  if (msg.type === "maf:get_context") {
    chrome.storage.session.get(["maf_cdu", "maf_site"])
      .then((o) => sendResponse({ ok: true, cdu: o.maf_cdu ?? null, site: o.maf_site ?? null }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

