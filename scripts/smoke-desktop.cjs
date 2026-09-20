'use strict';
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { CACHE_VERSION } = require('../lib/core.cjs');
const root = path.join(__dirname, '..');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-desktop-'));
  const source = path.join(temp, 'Pictures #1 ü'),
    userData = path.join(temp, 'user-data');
  await fs.mkdir(source);
  await fs.mkdir(userData);
  for (let i = 0; i < 12; i++) {
    await sharp({
      create: {
        width: 1200,
        height: 900,
        channels: 3,
        background: ['#93afa3', '#d0b9a5', '#8aa1b2'][i % 3],
      },
    })
      .jpeg()
      .withExif({
        IFD2: { DateTimeOriginal: `2024:06:${String(i + 1).padStart(2, '0')} 14:32:00` },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: `47/1 ${20 + i}/1 0/1`,
          GPSLongitudeRef: 'E',
          GPSLongitude: '8/1 32/1 0/1',
        },
      })
      .toFile(path.join(source, `Photo #${i} ü.jpg`));
  }
  await fs.copyFile(
    path.join(root, 'tests/fixtures/location.heic'),
    path.join(source, 'Location.heic'),
  );
  const video = path.join(source, 'Video #1 ü.mp4');
  execFileSync(
    require('ffmpeg-static'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-metadata',
      'location=+47.3769+008.5417/',
      '-metadata',
      'creation_time=2024-06-20T12:00:00Z',
      video,
    ],
    { windowsHide: true },
  );
  let app;
  try {
    const args = process.env.PHOTO_MAP_EXECUTABLE ? [] : [root];
    if (process.env.PHOTO_MAP_TEST_NO_SANDBOX === '1') args.push('--no-sandbox');
    const launchOptions = {
      executablePath: process.env.PHOTO_MAP_EXECUTABLE || require('electron'),
      args,
      env: { ...process.env, PHOTO_MAP_USER_DATA: userData },
      timeout: 30000,
    };
    app = await electron.launch(launchOptions);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await expect(page.locator('#empty-state')).toBeVisible();
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, source);
    await page.getByRole('button', { name: 'Choose your first folder' }).click();
    await expect(page.locator('#located-total')).toHaveText('14', { timeout: 45000 });
    await expect(page.locator('#scan-panel')).toBeHidden({ timeout: 45000 });
    await page.getByRole('button', { name: 'Fullscreen map', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    const cache = path.join(userData, 'photo-map-cache');
    const previews = path.join(cache, 'previews');
    if ((await fs.readdir(previews)).length)
      throw new Error('Full previews were generated during scanning');
    await page.getByRole('button', { name: 'Gallery', exact: true }).click();
    await page.locator('[data-type="photo"]').click();
    await page.locator('#gallery-scroll .gallery-card').first().click();
    await expect(page.locator('#viewer-loading')).toBeHidden({ timeout: 15000 });
    await expect(page.locator('#viewer-error')).toBeHidden();
    if (!(await fs.readdir(previews)).length) throw new Error('No on-demand preview generated');
    await expect
      .poll(() =>
        page.locator('#viewer-image').evaluate((img) => img.complete && img.naturalWidth === 1200),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await page.locator('[data-type="video"]').click();
    await page.locator('#gallery-scroll .gallery-card').first().click();
    await expect(page.locator('#viewer-video')).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() => page.locator('#viewer-video').evaluate((video) => video.readyState))
      .toBeGreaterThan(0);
    const range = await page.evaluate(async () => {
      const url = document.getElementById('viewer-video').src;
      // fetch is allowed only by the app CSP for media images? Video itself verifies range loading.
      return { duration: document.getElementById('viewer-video').duration, url };
    });
    if (range.duration < 1) throw new Error('Video duration not read');
    await page.locator('#viewer-video').evaluate((video) => {
      video.currentTime = 1;
    });
    await expect
      .poll(() => page.locator('#viewer-video').evaluate((video) => video.currentTime))
      .toBeGreaterThanOrEqual(1);
    await page.keyboard.press('Escape');
    await page.locator('[data-type="all"]').click();
    await page.locator('#search').fill('Location.heic');
    await expect(page.locator('#visible-count')).toHaveText('1');
    await page.locator('#gallery-scroll .gallery-card').first().click();
    await expect(page.locator('#viewer-loading')).toBeHidden({ timeout: 15000 });
    await expect(page.locator('#viewer-error')).toBeHidden();
    await expect
      .poll(() => page.locator('#viewer-image').evaluate((img) => img.complete && img.naturalWidth))
      .toBe(64);
    await page.keyboard.press('Escape');
    await page.locator('#reset-filters').click();
    await page.getByRole('button', { name: 'Rescan folders' }).click();
    await expect(page.locator('#status-text')).toContainText('14 unchanged files skipped', {
      timeout: 15000,
    });
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/desktop-linux.png') });
    if (errors.length) throw new Error(errors.join('\n'));
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.locator('[data-map-mode="bubbles"]').click();
    await page.locator('#show-labels').uncheck();
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setSize(1100, 660);
    });
    const savedSize = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    );
    await app.close();
    app = null;
    const metadataPath = path.join(cache, 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const stale = metadata.filter((entry) => entry.filename.endsWith('.jpg')).slice(0, 2);
    delete stale[0].cacheVersion;
    stale[1].cacheVersion = CACHE_VERSION - 1;
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    const oldThumb = path.join(cache, 'thumbnails', `${stale[0].id}_thumb.jpg`);
    await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff0000' } })
      .jpeg()
      .toFile(oldThumb);
    app = await electron.launch(launchOptions);
    const restarted = await app.firstWindow();
    restarted.on('pageerror', (err) => errors.push(err.message));
    await expect(restarted.locator('#status-text')).toContainText('12 unchanged files skipped', {
      timeout: 45000,
    });
    await expect(restarted.locator('[data-map-mode="bubbles"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(restarted.locator('#show-labels')).not.toBeChecked();
    const restoredSize = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    );
    if (restoredSize.join(',') !== savedSize.join(','))
      throw new Error(
        `Window size was not restored: wanted ${savedSize}, got ${restoredSize}, saved ${await fs.readFile(path.join(userData, 'window-state.json'), 'utf8')}`,
      );
    const refreshed = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    if (!refreshed.every((entry) => entry.cacheVersion === CACHE_VERSION))
      throw new Error('Restart did not upgrade all obsolete cache entries');
    const dimensions = await sharp(oldThumb).metadata();
    if (dimensions.width !== 320 || dimensions.height !== 240)
      throw new Error('Restart did not regenerate the obsolete thumbnail');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(
      'Desktop smoke passed: native picker IPC, scan, GPS, worker threads, preview protocol, video loading/seeking, native fullscreen, gallery, unchanged rescan, and automatic cache upgrades and workspace restoration after restart.',
    );
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
