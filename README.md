# Scans Anime-Sama → PDF

Service web autonome : on colle un lien de lecture Anime-Sama, on choisit une plage de
chapitres, et on télécharge **chaque PDF individuellement** au fil de l'eau.

Les scans sont au format le plus large possible : chaque page est normalisée à
**800 px de large** (ratio d'origine conservé, aucune ré-encodage), donc le zoom est
identique d'un chapitre à l'autre.

> Ce dossier est indépendant du reste du dépôt (CLI `scripts/`) et se déploie seul.

## Lancer en local

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # avec rechargement automatique
```

## Tests

```bash
npm test           # scraper + API de bout en bout (télécharge de vrais chapitres)
```

Les tests tapent le vrai site. Variables utiles :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | port d'écoute |
| `DATA_DIR` | `/tmp/manhwa` | dossier des PDF |
| `MAX_PDFS_KEPT` | `20` | PDF conservés par job avant expiration |
| `RATE_LIMIT_ANALYZE` | `20` | requêtes `/api/analyze` par minute et par IP |
| `RATE_LIMIT_JOBS` | `10` | requêtes `/api/jobs` par minute et par IP |

## Déployer sur Render

Le plus simple : **New → Blueprint**, et pointer Render sur ce dossier. `render.yaml`
suffit.

![déploiement](https://img.shields.io/badge/Render-deploy%20blueprint-46e3bb)

Sinon, service manual : runtime **Node**, build `npm install --omit=dev --no-audit --no-fund`,
start `node src/server.js`, health check `/healthz`.

### Docker (Railway, Fly, VPS…)

```bash
docker build -t anime-sama-pdf .
docker run -p 3000:3000 anime-sama-pdf
```

## API

| Route | Effet |
|---|---|
| `POST /api/analyze` | `{url}` → `{oeuvre, lang, firstChapter, lastChapter, totalChapters, pages}` |
| `POST /api/jobs` | `{url, start, end}` → `{id, status, chapters[]}` |
| `GET /api/jobs/:id` | progression + lien de téléchargement par chapitre |
| `GET /api/jobs/:id/chap/:n.pdf` | le PDF du chapitre |
| `DELETE /api/jobs/:id` | annule entre deux chapitres |
| `GET /healthz` | healthcheck |

`start`/`end` sont optionnels : sans valeur, toute l'œuvre est traitée.

## Piège : les espaces finaux du nom d'œuvre

L'API `get_nb_chap_et_img.php` et les dossiers d'images s'appellent avec la chaîne
**exacte** de `#titreOeuvre`, espaces finaux compris. Le catalogue n'est pas homogène :

| œuvre | chaîne attendue |
|---|---|
| `Noblesse` | `"Noblesse"` (rien) |
| `Tower of God` | `"Tower of God "` (1 espace) |
| `Return of the Frozen Player` | `"Return of the Frozen Player   "` (3 espaces) |

Normaliser ces espaces casse la recherche. `resolve()` renvoie donc la valeur brute du
DOM, `listChapters()` teste des variantes jusqu'à ce que l'API réponde, et un `HEAD`
sur `/s2/scans/<œuvre>/<chap>/1.jpg` confirme que le dossier d'images correspond.
**Ne pas « nettoyer » cette chaîne.**

## Ce qu'il faut savoir

- **Disque éphémère.** Les PDF vivent sur le disque du serveur. Un redéploiement les
  efface. Les fichiers déjà téléchargés sur ton appareil sont intacts. D'où la rétention
  à 20 PDF : tu télécharges au fil de l'eau, tu ne manques rien.
- **Pas de reprise.** Chaque job repart de son chapitre de début, comme demandé.
- **Instance free Render.** Elle se met en veille après 15 min sans trafic. Le
  rafraîchissement de l'interface toutes les 3 s compte comme trafic et la maintient
  éveillée. Pour un vrai service public : instance payante ou Background Worker.
- **Un seul job à la fois**, un seul job actif par IP, 10 connexions par chapitre —
  le service reste poli envers le site source.
- **`sharp` est optionnel** et chargé uniquement si une image n'est ni JPEG ni PNG. Si
  son binaire natif manque à l'installation, le service démarre quand même.
- Vérifie les conditions du site source avant d'exposer ce service publiquement.

## Arborescence

```
src/
  lib/image.js         validation anti-troncature (PNG/JPEG/WebP/GIF/AVIF)
  lib/toPdf.js         assemblage PDF, largeur 800, sharp paresseux
  scrapers/anime-sama.js  resolve / listChapters / downloadChapter
  jobs.js              file d'attente, progression, rétention, annulation
  server.js            API Express + garde-fous
public/index.html      interface
test/                  tests de bout en bout
```
# UI-manhwa-scrapper
