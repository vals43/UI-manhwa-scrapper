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

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { agent, headers: { "User-Agent": UA } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 3) return reject(new Error("Trop de redirections"));
          res.resume();
          return resolve(fetchBuffer(new URL(res.headers.location, url).href, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

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
      if (attempt === tries) break;
      console.warn(`  ${label} : ${error.message} (essai ${attempt}/${tries})`);
      await sleep(800 * attempt);
    }
  }
  throw last;
}

export async function resolve(rawUrl) {
  if (!isAllowedUrl(rawUrl)) throw new Error("URL non autorisée");

  const url = new URL(rawUrl);
  const match = url.pathname.match(/^\/catalogue\/([^/]+)\/scan\/([^/]+)/i);
  if (!match) throw new Error("URL Anime-Sama invalide : /catalogue/<slug>/scan/<langue>/");

  const page = await withRetry("page catalogue", () => fetchBuffer(url.href));
  const titre = page.toString("utf8").match(/id="titreOeuvre"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/i);
  if (!titre) throw new Error("Œuvre introuvable sur cette page");

  const oeuvre = decodeEntities(titre[1]).trimEnd() + " ";
  if (!oeuvre.trim()) throw new Error("Nom d'œuvre vide");

  return { slug: match[1], lang: match[2].toLowerCase(), oeuvre, url: url.href };
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

export async function listChapters(oeuvre) {
  const raw = await withRetry("API chapitres", () =>
    fetchBuffer(`${API}?oeuvre=${encodeURIComponent(oeuvre)}`)
  );
  const data = JSON.parse(raw.toString("utf8"));

  const pages = {};
  for (const [key, value] of Object.entries(data)) {
    const chap = Number.parseInt(key, 10);
    const count = Number.parseInt(value, 10);
    if (Number.isFinite(chap) && Number.isFinite(count) && count > 0) pages[chap] = count;
  }

  const list = Object.keys(pages).map(Number).sort((a, b) => a - b);
  if (!list.length) throw new Error("Aucun chapitre listé par l'API");

  return { pages, first: list[0], last: list[list.length - 1], total: list.length };
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
