import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.screenshots');
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(candidate => existsSync(candidate));
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
page.on('pageerror', error => problems.push(String(error)));
const snapshot = () => page.evaluate(() => window.__DSH_AQUARIUM_TEST__.scene.snapshot());
const waitFor = async (id, fish = 7) => {
  await page.waitForFunction(({ id, fish }) => {
    const scene = window.__DSH_AQUARIUM_TEST__?.scene;
    if (!scene) return false;
    const state = scene.snapshot();
    return state.scape.id === id && state.fish === fish;
  }, { id, fish }, { timeout: 20000 });
};
const results = [];
try {
  await page.goto(pathToFileURL(path.join(out, 'panel-preview.html')).href);
  await waitFor('scape.jungle');
  for (const id of ['scape.moss', 'scape.jungle', 'scape.driftwood']) {
    await page.evaluate(id => window.__preview.setScape(id), id);
    await waitFor(id);
    await page.waitForTimeout(1400);
    const first = await snapshot();
    assert.equal(first.scape.id, id);
    assert.equal(first.fish, 7);
    assert.ok(first.collision.length >= 8);
    assert.ok(first.scape.plantTriangles > 1000);
    await page.waitForTimeout(650);
    const second = await snapshot();
    assert.ok(second.scape.swayTime > first.scape.swayTime, `${id} plant time advances`);
    assert.equal(second.scape.swayStrength, 1);
    for (const fish of second.fishState) {
      for (const volume of second.collision.filter(item => item.kind === 'solid')) {
        const inside = ['x', 'y', 'z'].every((axis, index) =>
          Math.abs(fish[axis] - volume.center[index]) < volume.size[index] / 2 - 0.001);
        assert.equal(inside, false, `${id} ${fish.species} avoids ${volume.id}`);
      }
    }
    const name = id.split('.')[1];
    await page.screenshot({ path: path.join(out, `p3-${name}-light.png`) });
    results.push({
      id, collision: first.collision.length, calls: second.calls, fps: second.fps,
      memory: second.memory, scape: second.scape,
    });
  }

  // Feed immediately after an atomic preset switch; particles must still hit water.
  await page.evaluate(() => window.__preview.setScape('scape.jungle'));
  await waitFor('scape.jungle');
  const point = await page.evaluate(() => window.__DSH_AQUARIUM_TEST__.scene.project({ x: 0, y: 0.267, z: 0.025 }));
  await page.locator('.dsh-aq-tool').nth(1).click();
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(250);
  assert.equal((await snapshot()).food.length, 4, 'feeding works immediately after scape switch');
  await page.screenshot({ path: path.join(out, 'p3-jungle-feed.png') });
  await page.locator('.dsh-aq-tool').nth(1).click();

  // Quality moved to the settings page, so drive the same volatile config the
  // settings select writes and wait for the scene to observe it.
  const setQuality = async value => {
    await page.evaluate(next => globalThis.__DSH_AQUARIUM_TEST__.writeConfig([{ op: 'set', path: ['qualityMode'], value: next }]), value);
    await page.waitForFunction(next => globalThis.__DSH_AQUARIUM_TEST__.readConfig().value.qualityMode === next, value);
  };
  await setQuality('eco');
  await page.waitForTimeout(350);
  assert.equal((await snapshot()).scape.swayStrength, 0.58, 'eco reduces plant motion');
  await setQuality('standard');
  await page.evaluate(() => window.__preview.setDark(true));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'p3-jungle-dark.png') });
  await page.evaluate(() => window.__preview.setDark(false));

  // Revisit the first preset and ensure GPU resource counts return to the same level.
  await page.evaluate(() => window.__preview.setScape('scape.moss'));
  await waitFor('scape.moss');
  await page.waitForTimeout(500);
  const revisited = await snapshot();
  assert.equal(revisited.memory.geometries, results[0].memory.geometries, 'geometry count does not grow after preset cycle');
  assert.equal(revisited.memory.textures, results[0].memory.textures, 'texture count does not grow after preset cycle');

  // Settings selection is real state, not a disabled placeholder.
  await page.evaluate(() => window.__preview.setMode('page'));
  await page.locator('#dsh-aq-scape').selectOption('scape.driftwood');
  assert.equal(await page.locator('#dsh-aq-scape').inputValue(), 'scape.driftwood');
  await page.waitForFunction(() => window.__DSH_AQUARIUM_TEST__.readConfig().value.scapePresetId === 'scape.driftwood');
  assert.equal(await page.locator('#dsh-aq-scape').isDisabled(), false, 'selection remains editable after saving');
  await page.screenshot({ path: path.join(out, 'p3-settings-driftwood.png') });
  await page.evaluate(() => window.__preview.setMode('overlay'));
  await waitFor('scape.driftwood');

  // Every preset receives the same night and close-up visual evidence.
  for (const id of ['scape.moss', 'scape.jungle', 'scape.driftwood']) {
    await page.evaluate(id => window.__preview.setScape(id), id);
    await waitFor(id);
    const name = id.split('.')[1];
    await page.evaluate(() => window.__preview.setDark(true));
    await page.waitForTimeout(1600);
    await page.screenshot({ path: path.join(out, `p3-${name}-dark.png`) });
    await page.evaluate(() => window.__preview.setDark(false));
    await page.waitForTimeout(600);
    await page.mouse.move(760, 520);
    for (let step = 0; step < 8; step++) await page.mouse.wheel(0, -320);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `p3-${name}-detail.png`) });
    for (let step = 0; step < 8; step++) await page.mouse.wheel(0, 320);
    await page.waitForTimeout(500);
  }

  assert.deepEqual(problems, [], 'no browser or shader errors');
  const report = { status: 'PASS', results, revisited: { memory: revisited.memory }, problems };
  await writeFile(path.join(out, 'p3-probe.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
