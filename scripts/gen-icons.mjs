import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "extension");

function makeSvg(size) {
  const r = size * 0.42;
  const cx = size / 2;
  const cy = size / 2;
  const fontSize = size * 0.44;
  const radius = size * 0.18;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="#e64c1e"/>
  <text x="${cx}" y="${cy + fontSize * 0.36}" text-anchor="middle"
    font-family="Arial, sans-serif" font-weight="700" font-size="${fontSize}"
    fill="white" letter-spacing="-0.5">B↓</text>
</svg>`;
}

for (const size of [16, 48, 128]) {
  const svg = makeSvg(size);
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = resvg.render().asPng();
  const out = join(OUT, `icon${size}.png`);
  writeFileSync(out, png);
  console.log(`✓ icon${size}.png`);
}
