import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import * as jobs from "../src/jobs.js";
import * as scraper from "../src/scrapers/anime-sama.js";

const URL = "https://anime-sama.to/catalogue/the-greatest-estate-developer/scan/vf/";
const DATA_DIR = process.env.DATA_DIR;
const KEEP = Number(process.env.MAX_PDFS_KEPT);
const waitDone = async id => {
  for (;;) {
    const job = jobs.getJob(id);
    if (["done", "cancelled", "error"].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 1000));
  }
};
const pdfPages = async file => (await PDFDocument.load(await fs.readFile(file))).getPageCount();
const widths = async file => {
  const doc = await PDFDocument.load(await fs.readFile(file));
  return [...new Set(doc.getPages().map(p => Math.round(p.getWidth())))];
};

await fs.rm(DATA_DIR, { recursive: true, force: true });
await jobs.init();

console.log(`\n[1] allowlist`);
assert.equal(scraper.isAllowedUrl("http://169.254.169.254/"), false);
assert.equal(scraper.isAllowedUrl("https://anime-sama.to.evil.com/"), false);
assert.equal(scraper.isAllowedUrl("https://anime-sama.to/catalogue/x/scan/vf/"), true);
console.log("    SSRF / sous-domaine piégé rejetés ✓");

console.log(`\n[2] bounds de plage`);
await assert.rejects(() => jobs.createJob({ url: URL, start: 500, end: 600 }), /Plage invalide/);
const clamped = await jobs.createJob({ url: URL, start: 1, end: 500, ip: "clamp" });
assert.equal(clamped.start, 1);
assert.equal(clamped.end, 222, "la plage doit être ramenée au dernier chapitre disponible");
await jobs.cancelJob(clamped.id);
console.log("    hors-borne rejetée, 1–500 ramené à 1–222 ✓");

console.log(`\n[3a] job chapitres 1-${KEEP} (rien n'expire)`);
const keepJob = await jobs.createJob({ url: URL, start: 1, end: KEEP, ip: "test" });
const kept = await waitDone(keepJob.id);
assert.equal(kept.status, "done", `statut ${kept.status}: ${kept.error || ""}`);
assert.equal(kept.chapters.filter(c => c.status === "failed").length, 0, JSON.stringify(kept.chapters));

for (const c of kept.chapters) {
  const file = await jobs.pdfPath(kept, c.chap);
  assert.ok(file, `chap ${c.chap} expiré alors qu'il ne devrait pas l'être`);
  const pages = await pdfPages(file);
  const w = await widths(file);
  assert.deepEqual(w, [800], `chap ${c.chap}: largeur ${w} au lieu de [800]`);
  assert.equal(pages, c.pages, `chap ${c.chap}: ${pages} pages vs ${c.pages} téléchargées`);
  assert.ok(pages > 1, `chap ${c.chap}: PDF vide`);
  console.log(`    chap ${c.chap}: ${pages}p, largeur ${w[0]}, ${(c.bytes / 1024).toFixed(0)} Ko ✓`);
}

console.log(`\n[3b] rétention : job chapitres 1-${KEEP + 1}, on garde ${KEEP}`);
const job = await jobs.createJob({ url: URL, start: 1, end: KEEP + 1, ip: "test" });
const done = await waitDone(job.id);
assert.equal(done.status, "done", `statut ${done.status}: ${done.error || ""}`);
assert.equal(done.chapters.filter(c => c.status === "failed").length, 0, JSON.stringify(done.chapters));

const survivors = done.chapters.filter(c => c.status === "done" && !c.expired);
const expired = done.chapters.filter(c => c.expired);
assert.equal(expired.length, 1, `${expired.length} expirés au lieu de 1`);
assert.equal(expired[0].chap, 1, "le chapitre le plus ancien doit expirer en premier");
assert.equal(expired[0].bytes, null, "un PDF expiré ne doit plus exposer sa taille");
assert.equal(survivors.length, KEEP);
assert.equal(await jobs.pdfPath(done, 1), null, "chapitre expiré encore servi");
console.log(`    ${survivors.map(c => `chap ${c.chap}`).join(", ")} gardés · chap 1 expiré ✓`);


console.log(`\n[4] un seul job actif par IP`);
const a = await jobs.createJob({ url: URL, start: 1, end: 1, ip: "9.9.9.9" });
assert.equal(jobs.countActiveForIp("9.9.9.9"), 1);
assert.equal(jobs.countActiveForIp("8.8.8.8"), 0);
await jobs.cancelJob(a.id);
console.log("    quota par IP appliqué ✓");

console.log(`\n[5] images nettoyées après PDF`);
const leftovers = await fs.readdir(path.join(DATA_DIR, done.id)).catch(() => []);
console.log(`    contenu du dossier job : ${leftovers.join(", ") || "vide"} ✓`);
assert.ok(!leftovers.includes("img"));

console.log(`\n[6] healthz du job\n`);
console.log(JSON.stringify(jobs.jobToJson(done).progress));
console.log("\nTOUT EST VERT\n");
