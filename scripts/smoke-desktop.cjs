'use strict';
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
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
    app = await electron.launch({
      executablePath: process.env.PHOTO_MAP_EXECUTABLE || require('electron'),
      args,
      env: { ...process.env, PHOTO_MAP_USER_DATA: userData },
      timeout: 30000,
    });
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
    console.log(
      'Desktop smoke passed: native picker IPC, scan, GPS, worker threads, preview protocol, video loading/seeking, gallery, and unchanged rescan.',
    );
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
