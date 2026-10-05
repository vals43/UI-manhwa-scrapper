import fs from "fs/promises";
import path from "path";
import { PDFDocument } from "pdf-lib";

export const TARGET_WIDTH = 800;

let sharpPromise = null;

async function getSharp() {
  if (!sharpPromise) sharpPromise = import("sharp").then(mod => mod.default);
  return sharpPromise;
}

export default async function toPdf(chap, saveFolder) {
  const save = path.join(saveFolder, `chapitre${chap}.pdf`);
  const doc = await PDFDocument.create();
  const files = (await fs.readdir(saveFolder))
    .filter(name => /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const file of files) {
    const full = path.join(saveFolder, file);
    const imgBytes = await fs.readFile(full);
    const head = imgBytes.subarray(0, 8).toString("hex").toLowerCase();
    let image;

    if (head === "ffd8ff") {
      image = await doc.embedJpg(imgBytes);
    } else if (head.startsWith("89504e47")) {
      image = await doc.embedPng(imgBytes);
    } else {
      const sharp = await getSharp();
      image = await doc.embedJpg(await sharp(imgBytes).jpeg().toBuffer());
    }

    const display = image.scale(TARGET_WIDTH / image.width);
    const size = display.height < 30 ? 30 : display.height;
    const page = doc.addPage([TARGET_WIDTH, size]);
    page.drawImage(image, { x: 0, y: 0, width: display.width, height: display.height });
  }

  await fs.writeFile(save, await doc.save());
  return save;
}
