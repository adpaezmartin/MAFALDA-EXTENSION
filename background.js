// background.js — MV3 service worker
// - Proxy para llamar al Apps Script con cookies corporativas (evita CORS)
// - Guarda/lee contexto simple si lo necesitás (CDU/SITE)

function normalizeAppsScriptUrl(u) {
  if (!u) return u;
  // Acepta URL /a/macros/.../s/…/exec y la normaliza a /macros/s/…/exec
  return String(u).replace(
    /https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\//,
    "https://script.google.com/macros/s/"
  );
}

async function fetchJSONWithCookies(url, bodyObj) {
  const resp = await fetch(url, {
    method: "POST",
    credentials: "include",            // importante para “Anyone within …”
    cache: "no-store",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // sin preflight
    body: JSON.stringify(bodyObj || {})
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} – ${raw.slice(0, 300)}`);
  }

  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error("La respuesta del Apps Script no es JSON válido"); }

  return data;
}

// === Mensajería desde content/popup ===
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // 1) Proxy de análisis IA
  if (msg.type === "maf:ai_analyze") {
    (async () => {
      try {
        const remote = normalizeAppsScriptUrl(msg.remoteUrl || "");
        if (!remote) throw new Error("URL remota vacía.");

        const payload = {
          op: "analyze",
          text: String(msg.text || ""),
          cdu: msg.cdu ?? null,
          site: msg.site ?? null
        };

        const data = await fetchJSONWithCookies(remote, payload);

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

  // 2) (Opcional) Guardar contexto detectado por content.js
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
