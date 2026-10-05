import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import * as scraper from "./scrapers/anime-sama.js";
import * as jobs from "./jobs.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PUBLIC = path.join(ROOT, "..", "public");
const ANALYZE_MAX = Number.parseInt(process.env.RATE_LIMIT_ANALYZE || "20", 10);
const JOBS_MAX = Number.parseInt(process.env.RATE_LIMIT_JOBS || "10", 10);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(PUBLIC, { maxAge: "1h" }));

// Un seau par limiteur : sinon /api/analyze saturerait aussi /api/jobs.
const buckets = [];

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  buckets.push(hits);

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "inconnu";
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now > entry.reset) {
      hits.set(ip, { count: 1, reset: now + windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      const seconds = Math.ceil((entry.reset - now) / 1000);
      return res.status(429).json({ error: `Trop de requêtes. Réessaie dans ${seconds}s.` });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const hits of buckets) {
    for (const [ip, entry] of hits) if (now > entry.reset) hits.delete(ip);
  }
}, 60_000).unref();

app.get("/healthz", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post("/api/analyze", rateLimit({ windowMs: 60_000, max: ANALYZE_MAX }), async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!scraper.isAllowedUrl(url)) throw new Error("Seuls les liens anime-sama.to sont acceptés");
    const info = await scraper.resolveOeuvre(url);
    res.json({
      slug: info.slug,
      oeuvre: info.oeuvre.trim(),
      lang: info.lang,
      firstChapter: info.first,
      lastChapter: info.last,
      totalChapters: info.total,
      pages: info.pages,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/jobs", rateLimit({ windowMs: 60_000, max: JOBS_MAX }), async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || null;
    if (jobs.countActiveForIp(ip) >= 1) {
      throw new Error("Tu as déjà un job en cours. Attends la fin ou annule-le.");
    }
    const job = await jobs.createJob({
      url: String(req.body?.url || "").trim(),
      start: req.body?.start,
      end: req.body?.end,
      ip,
    });
    res.status(202).json(jobs.jobToJson(job));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(jobs.jobToJson(job));
});

app.delete("/api/jobs/:id", (req, res) => {
  try {
    res.json(jobs.jobToJson(jobs.cancelJob(req.params.id)));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get("/api/jobs/:id/chap/:file", async (req, res) => {
  const match = req.params.file.match(/^(\d+)\.pdf$/);
  if (!match) return res.status(400).json({ error: "Nom de fichier invalide" });

  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });

  const chap = Number.parseInt(match[1], 10);
  const file = await jobs.pdfPath(job, chap);
  if (!file) {
    return res.status(404).json({ error: "Chapitre indisponible (expiré ou pas encore généré)" });
  }
  res.download(file, `chapitre${chap}.pdf`);
});

app.use((_req, res) => res.status(404).json({ error: "Route inconnue" }));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Erreur interne" });
});

await jobs.init();

if (!fs.existsSync(path.join(PUBLIC, "index.html"))) {
  console.error("public/index.html introuvable");
  process.exit(1);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`UI Render en écoute sur http://0.0.0.0:${PORT}`);
});
