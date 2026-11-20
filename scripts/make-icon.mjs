/**
 * 把 `icon.svg` 光栅化成市场用的 PNG（180 / 512 两档）。
 *
 * 用途：dsh-market 的条目 `icon` 只认 GitHub 托管的位图，SVG 会被拒。
 * 产物：`assets/icon-180.png`（市场卡片）、`assets/icon-512.png`（GitHub 社交预览）。
 *
 *   node scripts/make-icon.mjs
 */
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const svg = await readFile(path.join(root, 'icon.svg'), 'utf8');
await mkdir(path.join(root, 'assets'), { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' });
try {
  for (const size of [180, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`,
    );
    const out = path.join(root, 'assets', `icon-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true });
    console.log(`${path.relative(root, out)}: ${size}x${size}`);
    await page.close();
  }
} finally {
  await browser.close();
}
