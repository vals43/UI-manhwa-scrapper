import fs from "fs/promises";
import https from "https";
import { isCompleteImage, describeMagic } from "../lib/image.js";

export const HOSTS = ["anime-sama.to", "www.anime-sama.to"];

const SCAN_BASE = "https://anime-sama.to/s2/scans/";
const API = "https://anime-sama.to/s2/scans/get_nb_chap_et_img.php";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const CONCURRENCY = 10;
const MAX_FAILS = 3;

const agent = new https.Agent({ family: 4, keepAlive: true, maxSockets: CONCURRENCY });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, url) {
    super(
      status === 403
        ? "Le site source bloque temporairement (protection anti-bot). Réessaie dans quelques minutes."
        : status === 429
          ? "Le site source limite les requêtes. Réessaie dans quelques minutes."
          : status === 404
            ? "Introuvable sur le site source"
            : `Le site source a répondu HTTP ${status}`,
    );
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

const retryable = error =>
  !(error instanceof HttpError) ||
  error.status === 403 ||
  error.status === 429 ||
  error.status >= 500;

const backoffFor = error =>
  error instanceof HttpError && (error.status === 403 || error.status === 429)
    ? [5000, 15000]
    : [800, 1600];

function request(url, { method = "GET", redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const call = https.request(url, { agent, method, headers: { "User-Agent": UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects > 3) return reject(new Error("Trop de redirections"));
        return resolve(request(new URL(res.headers.location, url).href, { method, redirects: redirects + 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new HttpError(res.statusCode, url));
      }
      if (method === "HEAD") {
        res.resume();
        return resolve(Buffer.alloc(0));
      }
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    call.on("error", reject);
    call.end();
  });
}

const fetchBuffer = url => request(url);

export function isAllowedUrl(raw) {
  try {
    return HOSTS.includes(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function withRetry(label, fn, tries = 3) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!retryable(error) || attempt === tries) break;
      const wait = backoffFor(error)[Math.min(attempt - 1, 1)];
      console.warn(`  ${label} : ${error.message} (essai ${attempt}/${tries}, ${wait / 1000}s)`);
      await sleep(wait);
    }
  }
  throw last;
}

// L'API et les dossiers d'images d'Anime-Sama s'appellent avec la chaîne EXACTE
// de #titreOeuvre, espaces finaux compris : "Return of the Frozen Player   " en
// compte trois. Toute normalisation casse les œuvres concernées.
export function oeuvreVariants(raw) {
  const core = raw.replace(/[\t\n\r]+/g, " ").replace(/ {2,}/g, " ").trimEnd();
  const trail = raw.slice(raw.trimEnd().length);
  return [...new Set([raw, core + trail, core + " ", core])].filter(candidate => candidate.trim());
}

export async function resolve(rawUrl) {
  if (!isAllowedUrl(rawUrl)) throw new Error("URL non autorisée");

  const url = new URL(rawUrl);
  const match = url.pathname.match(/^\/catalogue\/([^/]+)\/scan\/([^/]+)/i);
  if (!match) throw new Error("URL Anime-Sama invalide : /catalogue/<slug>/scan/<langue>/");

  const page = await withRetry("page catalogue", () => fetchBuffer(url.href));
  const titre = page.toString("utf8").match(/id="titreOeuvre"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/i);
  if (!titre) throw new Error("Œuvre introuvable sur cette page");

  const raw = decodeEntities(titre[1]);
  if (!raw.trim()) throw new Error("Nom d'œuvre vide");

  return { slug: match[1], lang: match[2].toLowerCase(), oeuvre: raw, url: url.href };
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

async function tryListChapters(oeuvre) {
  let data;
  try {
    const raw = await fetchBuffer(`${API}?oeuvre=${encodeURIComponent(oeuvre)}`);
    data = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const pages = {};
  for (const [key, value] of Object.entries(data)) {
    const chap = Number.parseInt(key, 10);
    const count = Number.parseInt(value, 10);
    if (Number.isFinite(chap) && Number.isFinite(count) && count > 0) pages[chap] = count;
  }
  const list = Object.keys(pages).map(Number).sort((a, b) => a - b);
  if (!list.length) return null;

  return { pages, first: list[0], last: list[list.length - 1], total: list.length };
}

// Retourne la variante qui répond réellement, pas seulement la première.
export async function listChapters(oeuvre) {
  for (const candidate of oeuvreVariants(oeuvre)) {
    const result = await withRetry("API chapitres", () => tryListChapters(candidate));
    if (result) {
      if (candidate !== oeuvre) {
        console.warn(`  « ${oeuvre} » rejeté par l'API, variante gagnante : ${JSON.stringify(candidate)}`);
      }
      return { oeuvre: candidate, ...result };
    }
  }
  throw new Error("Aucun chapitre listé par l'API");
}

// Un HEAD suffit : le dossier d'images doit porter le même nom que la clé d'API.
async function folderExists(oeuvre, chap) {
  try {
    await request(`${SCAN_BASE}${encodeURIComponent(oeuvre)}/${chap}/1.jpg`, { method: "HEAD" });
    return true;
  } catch {
    return false;
  }
}

export async function resolveOeuvre(rawUrl) {
  const info = await resolve(rawUrl);
  const list = await listChapters(info.oeuvre);

  if (await folderExists(list.oeuvre, list.first)) {
    return { ...info, oeuvre: list.oeuvre, ...list };
  }

  for (const candidate of oeuvreVariants(info.oeuvre)) {
    if (candidate === list.oeuvre) continue;
    const alt = await withRetry("API chapitres", () => tryListChapters(candidate));
    if (alt && (await folderExists(candidate, alt.first))) {
      return { ...info, oeuvre: candidate, ...alt };
    }
  }

  throw new Error("Chapitres listés par l'API mais dossier d'images introuvable");
}

async function downloadOne(outDir, oeuvre, chap, page) {
  const url = `${SCAN_BASE}${encodeURIComponent(oeuvre)}/${chap}/${page}.jpg`;
  const file = `${outDir}/${page}.jpg`;

  try {
    const existing = await fs.readFile(file);
    if (isCompleteImage(existing)) return true;
  } catch {
    /* absent ou illisible */
  }
  await fs.rm(file, { force: true });

  for (let attempt = 1; attempt <= MAX_FAILS; attempt++) {
    try {
      const buffer = await fetchBuffer(url);
      if (!isCompleteImage(buffer)) {
        throw new Error(`image tronquée (${describeMagic(buffer)})`);
      }
      await fs.writeFile(file, buffer);
      return true;
    } catch (error) {
      if (attempt === MAX_FAILS) {
        console.error(`  chap ${chap} page ${page} : ${error.message}`);
        return false;
      }
      if (!retryable(error)) return false;
      await sleep(600 * attempt);
    }
  }
  return false;
}

async function downloadPages(outDir, oeuvre, chap, from, to) {
  await fs.mkdir(outDir, { recursive: true });
  const queue = [];
  for (let page = from; page <= to; page++) queue.push(page);

  let done = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const page = queue.shift();
      const ok = await downloadOne(outDir, oeuvre, chap, page);
      if (ok) done++;
    }
  });

  await Promise.all(workers);
  return done;
}

export async function downloadChapter({ oeuvre, chap, nbPages, outDir }) {
  if (!nbPages) {
    let page = 1;
    while (await downloadOne(outDir, oeuvre, chap, page)) page++;
    const count = page - 1;
    if (!count) throw new Error("Aucune image trouvée");
    return { pages: count, expected: count };
  }

  await downloadPages(outDir, oeuvre, chap, 1, nbPages);

  const validPages = async () => {
    let count = 0;
    for (let page = 1; page <= nbPages; page++) {
      try {
        const buffer = await fs.readFile(`${outDir}/${page}.jpg`);
        if (isCompleteImage(buffer)) count++;
      } catch {
        /* page absente */
      }
    }
    return count;
  };

  if ((await validPages()) < nbPages) {
    await sleep(1500);
    const missing = [];
    for (let page = 1; page <= nbPages; page++) {
      try {
        const buffer = await fs.readFile(`${outDir}/${page}.jpg`);
        if (!isCompleteImage(buffer)) missing.push(page);
      } catch {
        missing.push(page);
      }
    }
    for (const page of missing) {
      await downloadOne(outDir, oeuvre, chap, page);
    }
  }

  const done = await validPages();
  if (done < nbPages) {
    throw new Error(`${done}/${nbPages} pages téléchargées`);
  }
  return { pages: done, expected: nbPages };
}

export async function cleanImages(outDir) {
  await fs.rm(outDir, { recursive: true, force: true });
}
