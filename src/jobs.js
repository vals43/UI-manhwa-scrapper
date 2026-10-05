import fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import toPdf from "./lib/toPdf.js";
import * as scraper from "./scrapers/anime-sama.js";

const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), "manhwa");
const MAX_PDFS_KEPT = Math.max(1, Number.parseInt(process.env.MAX_PDFS_KEPT || "20", 10));
const MAX_CHAPTERS = 500;

const jobs = new Map();
const queue = [];
let running = false;

const safeSlug = slug =>
  slug
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "scan";

const chapOf = file => Number.parseInt(file.match(/chapitre(\d+)\.pdf/)?.[1] || "0", 10);

export async function init() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export function getJob(id) {
  return jobs.get(id);
}

export function jobToJson(job) {
  return {
    id: job.id,
    url: job.url,
    slug: job.slug,
    oeuvre: job.oeuvre.trim(),
    lang: job.lang,
    status: job.status,
    start: job.start,
    end: job.end,
    totalChapters: job.totalChapters,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: {
      done: job.chapters.filter(c => c.status === "done").length,
      failed: job.chapters.filter(c => c.status === "failed").length,
      total: job.end - job.start + 1,
      current: job.current,
    },
    chapters: job.chapters.map(c => ({
      chap: c.chap,
      status: c.status,
      pages: c.pages,
      expected: c.expected,
      bytes: c.bytes,
      expired: Boolean(c.expired),
      error: c.error,
      downloadUrl: c.status === "done" && !c.expired ? `/api/jobs/${job.id}/chap/${c.chap}.pdf` : null,
    })),
  };
}

export async function createJob({ url, start, end, ip = null }) {
  if (!scraper.isAllowedUrl(url)) throw new Error("URL non autorisée");
  if (!scraper.HOSTS.includes(new URL(url).hostname.toLowerCase())) throw new Error("Hôte non autorisé");

  const info = await scraper.resolve(url);
  const list = await scraper.listChapters(info.oeuvre);

  let from = Number.parseInt(start, 10);
  let to = Number.parseInt(end, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    from = list.first;
    to = list.last;
  }
  from = Math.max(from, list.first);
  to = Math.min(to, list.last);
  if (to < from) throw new Error(`Plage invalide : l'œuvre a ${list.first}–${list.last}`);
  if (to - from + 1 > MAX_CHAPTERS) throw new Error(`Maximum ${MAX_CHAPTERS} chapitres par job`);

  const id = randomUUID();
  const chapters = [];
  for (let chap = from; chap <= to; chap++) {
    chapters.push({
      chap,
      nbPages: list.pages[chap] || null,
      status: "pending",
      pages: null,
      expected: null,
      bytes: null,
      expired: false,
      error: null,
    });
  }

  const job = {
    id,
    url: info.url,
    slug: safeSlug(info.slug),
    oeuvre: info.oeuvre,
    lang: info.lang,
    start: from,
    end: to,
    totalChapters: list.total,
    status: "queued",
    current: null,
    cancelRequested: false,
    ip,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    chapters,
  };

  jobs.set(id, job);
  queue.push(id);
  queueMicrotask(drain);
  return job;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error("Job introuvable");
  if (job.status === "done" || job.status === "cancelled") return job;
  job.cancelRequested = true;
  if (job.status === "queued") {
    queue.splice(queue.indexOf(id), 1);
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

async function applyRetention(job) {
  const pdfDir = path.join(DATA_DIR, job.id, "pdf");
  let files;
  try {
    files = (await fs.readdir(pdfDir)).filter(name => /^chapitre\d+\.pdf$/.test(name));
  } catch {
    return;
  }
  if (files.length <= MAX_PDFS_KEPT) return;

  files.sort((a, b) => chapOf(a) - chapOf(b));
  const doomed = files.slice(0, files.length - MAX_PDFS_KEPT);
  for (const file of doomed) {
    await fs.rm(path.join(pdfDir, file), { force: true });
    const record = job.chapters.find(c => c.chap === chapOf(file));
    if (record) {
      record.expired = true;
      record.bytes = null;
    }
  }
}

async function runChapter(job, record) {
  const imgDir = path.join(DATA_DIR, job.id, "img");
  const pdfDir = path.join(DATA_DIR, job.id, "pdf");
  await fs.mkdir(pdfDir, { recursive: true });

  try {
    const result = await scraper.downloadChapter({
      oeuvre: job.oeuvre,
      chap: record.chap,
      nbPages: record.nbPages,
      outDir: imgDir,
    });

    await toPdf(record.chap, imgDir);
    await fs.rename(path.join(imgDir, `chapitre${record.chap}.pdf`), path.join(pdfDir, `chapitre${record.chap}.pdf`));
    await scraper.cleanImages(imgDir);

    const stat = await fs.stat(path.join(pdfDir, `chapitre${record.chap}.pdf`));
    record.status = "done";
    record.pages = result.pages;
    record.expected = result.expected;
    record.bytes = stat.size;
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    await scraper.cleanImages(imgDir);
  }
}

async function runJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  console.log(`[job ${job.id}] ${job.oeuvre.trim()} — chapitres ${job.start}–${job.end}`);

  for (const record of job.chapters) {
    if (job.cancelRequested) {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      console.log(`[job ${job.id}] annulé au chapitre ${record.chap}`);
      return;
    }
    job.current = record.chap;
    await runChapter(job, record);
    await applyRetention(job);
  }

  job.status = "done";
  job.current = null;
  job.finishedAt = new Date().toISOString();
  console.log(`[job ${job.id}] terminé`);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = jobs.get(queue.shift());
      if (!job || job.cancelRequested) continue;
      try {
        await runJob(job);
      } catch (error) {
        job.status = "error";
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
        console.error(`[job ${job.id}] erreur : ${error.message}`);
      }
    }
  } finally {
    running = false;
  }
}

export async function pdfPath(job, chap) {
  const record = job.chapters.find(c => c.chap === chap);
  if (!record || record.status !== "done" || record.expired) return null;
  const file = path.join(DATA_DIR, job.id, "pdf", `chapitre${chap}.pdf`);
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

export function activeJobs() {
  return jobs.size;
}

const ACTIVE = new Set(["queued", "running"]);

export function countActiveForIp(ip) {
  if (!ip) return 0;
  let count = 0;
  for (const job of jobs.values()) {
    if (job.ip === ip && ACTIVE.has(job.status)) count++;
  }
  return count;
}
