import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const URL = "https://anime-sama.to/catalogue/the-greatest-estate-developer/scan/vf/";

const server = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: process.env.DATA_DIR, MAX_PDFS_KEPT: "5" },
  stdio: "ignore",
});

const stop = () => server.kill("SIGKILL");
process.on("exit", stop);

const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await req("/healthz")).status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("le serveur n'a pas démarré");
};

const req = async (route, opts) => {
  const res = await fetch(BASE + route, opts);
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : await res.arrayBuffer();
  return { status: res.status, body, headers: res.headers };
};
const post = (route, payload) =>
  req(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

// Envoie le chemin tel quel, sans la normalisation faite par fetch.
const rawReq = route =>
  new Promise((resolve, reject) => {
    const call = http.request({ host: "127.0.0.1", port: PORT, path: route, method: "GET" }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    call.on("error", reject);
    call.end();
  });

await waitReady();

console.log("\n[1] page d'accueil");
const home = await req("/");
assert.equal(home.status, 200);
assert.match(Buffer.from(home.body).toString("utf8"), /Anime-Sama/);
console.log("    index.html servi ✓");

console.log("\n[2] /healthz");
const health = await req("/healthz");
assert.equal(health.body.ok, true);
console.log(`    ok, uptime ${health.body.uptime.toFixed(1)}s ✓`);

console.log("\n[3] analyze");
const good = await post("/api/analyze", { url: URL });
assert.equal(good.status, 200, `analyze a échoué : ${JSON.stringify(good.body)}`);
assert.equal(good.body.oeuvre, "The Greatest Estate Developer");
assert.equal(good.body.lastChapter, 222);
console.log(`    ${good.body.oeuvre} — 1–${good.body.lastChapter} ✓`);

// Régression : cette œuvre a trois espaces finaux dans #titreOeuvre.
const frozen = await post("/api/analyze", {
  url: "https://anime-sama.to/catalogue/return-of-the-frozen-player/scan/vf/",
});
assert.equal(frozen.status, 200, `analyze Frozen Player a échoué : ${JSON.stringify(frozen.body)}`);
assert.equal(frozen.body.oeuvre, "Return of the Frozen Player");
assert.equal(frozen.body.lastChapter, 225);
assert.equal(frozen.body.totalChapters, 225);
console.log(`    ${frozen.body.oeuvre} — 1–${frozen.body.lastChapter} ✓`);

for (const bad of ["http://169.254.169.254/", "https://anime-sama.to.evil.com/x", "https://mangatown.com/manga/x/", "pas une url"]) {
  const res = await post("/api/analyze", { url: bad });
  assert.equal(res.status, 400, `${bad} aurait dû être refusé`);
}
console.log("    SSRF, sous-domaine piégé, autre site, URL invalide → 400 ✓");

console.log("\n[4] job Frozen Player chapitre 1 (dossier d'images à 3 espaces)");
const created = await post("/api/jobs", {
  url: "https://anime-sama.to/catalogue/return-of-the-frozen-player/scan/vf/",
  start: 1,
  end: 1,
});
assert.equal(created.status, 202, JSON.stringify(created.body));
const id = created.body.id;
console.log(`    job ${id.slice(0, 8)}… créé (202) ✓`);

let state;
for (let i = 0; i < 200; i++) {
  state = (await req(`/api/jobs/${id}`)).body;
  if (["done", "error", "cancelled"].includes(state.status)) break;
  await new Promise(r => setTimeout(r, 1000));
}
assert.equal(state.status, "done", `statut ${state.status}`);
assert.equal(state.progress.done, 1);
assert.equal(state.progress.failed, 0, JSON.stringify(state.chapters));
assert.equal(state.chapters[0].pages, 11, "11 pages attendues");
assert.equal(state.chapters[0].downloadUrl, `/api/jobs/${id}/chap/1.pdf`);
console.log(`    terminé, 11 pages téléchargées ✓`);

console.log("\n[5] téléchargement du PDF");
const pdf = await req(`/api/jobs/${id}/chap/1.pdf`);
assert.equal(pdf.status, 200);
assert.match(pdf.headers.get("content-type"), /application\/pdf/);
assert.match(pdf.headers.get("content-disposition") || "", /chapitre1\.pdf/);
assert.equal(Buffer.from(pdf.body).slice(0, 5).toString(), "%PDF-");
const doc = await PDFDocument.load(Buffer.from(pdf.body));
const widths = [...new Set(doc.getPages().map(p => Math.round(p.getWidth())))];
assert.equal(doc.getPageCount(), 11);
assert.deepEqual(widths, [800], `largeurs ${widths} au lieu de [800]`);
console.log(`    PDF servi, ${(pdf.body.byteLength / 1024).toFixed(0)} Ko, ${doc.getPageCount()} pages, largeur ${widths[0]} ✓`);

console.log("\n[6] cas d'erreur");
const cases = [
  [`/api/jobs/${id}/chap/2.pdf`, 404, "chapitre hors de la plage du job"],
  [`/api/jobs/${id}/chap/99999999999999999999.pdf`, 404, "chapitre inexistant"],
  ["/api/jobs/00000000-0000-0000-0000-000000000000", 404, "job inconnu"],
  ["/api/nimporte-quoi", 404, "route inconnue"],
];
for (const [route, expected, label] of cases) {
  const res = await req(route);
  assert.equal(res.status, expected, `${label}: ${res.status} au lieu de ${expected}`);
  console.log(`    ${label} → ${res.status} ✓`);
}

// fetch normalise ".." avant l'envoi : on frappe la garde en HTTP brut.
const raw = await rawReq(`/api/jobs/${id}/chap/..%2F..%2F..%2Fetc%2Fpasswd.pdf`);
assert.equal(raw.status, 400, `traversée de répertoire: ${raw.status}`);
console.log("    traversée de répertoire encodée → 400 ✓");

assert.equal((await req(`/api/jobs/${id}`, { method: "DELETE" })).status, 200);

console.log("\n[7] rate limit (serveur dédié, limite 3/min)");
stop();
await new Promise(r => setTimeout(r, 500));

const strict = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: process.env.DATA_DIR,
    RATE_LIMIT_ANALYZE: "3",
    RATE_LIMIT_JOBS: "1",
  },
  stdio: "ignore",
});
const stopStrict = () => strict.kill("SIGKILL");
process.on("exit", stopStrict);
await waitReady();

const codes = [];
for (let i = 0; i < 6; i++) codes.push((await post("/api/analyze", { url: URL })).status);
assert.deepEqual(codes.slice(0, 3), [200, 200, 200], `3 premières doivent passer : ${codes}`);
assert.ok(codes.slice(3).every(c => c === 429), `les suivantes doivent être 429 : ${codes}`);
console.log(`    analyze : ${codes.join(",")} → 3 OK puis blocage ✓`);

// /api/jobs a son propre compteur : 1re requête traitée, 2e bloquée.
const first = await post("/api/jobs", { url: URL, start: 900, end: 901 });
assert.equal(first.status, 400, "plage invalide : le limiteur laisse passer, le handler refuse");
const second = await post("/api/jobs", { url: URL, start: 900, end: 901 });
assert.equal(second.status, 429, "2e requête jobs bloquée par sa propre limite");
console.log("    jobs    : 400 puis 429 → compteur indépendant ✓");

stopStrict();
console.log("\nTOUT EST VERT\n");
process.exit(0);
