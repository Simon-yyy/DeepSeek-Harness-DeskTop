// Generate build/icon.ico from build/icon-source.svg using png-to-ico
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIcoModule from "png-to-ico";

const pngToIco = pngToIcoModule.default?.default || pngToIcoModule.default || pngToIcoModule;

const here = path.dirname(fileURLToPath(import.meta.url));
const srcSvg = path.join(here, "build", "icon-source.svg");
const outIcoBuild = path.join(here, "build", "icon.ico");
const outIcoRoot = path.join(here, "icon.ico");

const raw = readFileSync(srcSvg, "utf8");
const pathMatch = raw.match(/<path[\s\S]*?\/>|<path[\s\S]*?<\/path>/i);
if (!pathMatch) throw new Error("no path found in icon-source.svg");
const pathBlack = pathMatch[0]
  .replace(/fill="[^"]*"/g, 'fill="#111827"')
  .replace(/fill-opacity="[^"]*"/g, 'fill-opacity="1"');

// Classic Black DeepSeek Whale on clean white squircle (Typora/Cursor desktop style)
const createWhaleSvg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="100%" stop-color="#F3F4F6" />
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="130%" height="130%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000000" flood-opacity="0.16" />
    </filter>
  </defs>
  
  <!-- Clean rounded squircle matching Typora / Cursor on desktop -->
  <rect x="36" y="36" width="440" height="440" rx="100" ry="100" fill="url(#bgGrad)" filter="url(#shadow)" />
  <rect x="37" y="37" width="438" height="438" rx="99" ry="99" fill="none" stroke="rgba(0,0,0,0.08)" stroke-width="2" />
  
  <!-- DeepSeek Black Whale -->
  <svg x="86" y="86" width="340" height="340" viewBox="0 0 50 50">
    ${pathBlack}
  </svg>
</svg>
`.trim();

const svg512 = createWhaleSvg(512);
const previewPng = await sharp(Buffer.from(svg512)).resize(512, 512).png().toBuffer();
writeFileSync(path.join(here, "preview-black-whale.png"), previewPng);

const sizes = [256, 128, 64, 48, 32, 16];
const pngBuffers = [];
for (const size of sizes) {
  const buf = await sharp(Buffer.from(createWhaleSvg(size))).resize(size, size).png().toBuffer();
  pngBuffers.push(buf);
}

const icoBuf = await pngToIco(pngBuffers);
writeFileSync(outIcoBuild, icoBuf);
writeFileSync(outIcoRoot, icoBuf);

console.log(`Generated standard multi-resolution Black Whale icon.ico (${icoBuf.length} bytes)`);





