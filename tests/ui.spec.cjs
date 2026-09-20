const { test, expect } = require('@playwright/test');
const path = require('node:path');
async function setup(page, size = 180, tiles = false) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  if (!tiles)
    await page.route('https://*.arcgisonline.com/**', (route) =>
      route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQIHWP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
          'base64',
        ),
      }),
    );
  await page.addInitScript(
    ({ size }) => {
      const positions = [
        [46.6863, 7.8632],
        [46.6242, 8.0414],
        [46.577, 8.005],
        [47.3769, 8.5417],
        [46.0207, 7.7491],
        [46.452, 6.8499],
      ];
      const names = [
        'Morning in the mountains',
        'A quiet afternoon',
        'On the trail',
        'By the water',
        'The long way home',
        'Summer days',
      ];
      const items = Array.from({ length: size }, (_, i) => ({
        id: i.toString(16).padStart(32, '0'),
        lat: positions[i % 6][0] + (i % 11) * 0.003,
        lng: positions[i % 6][1] + (i % 7) * 0.003,
        date: new Date(Date.UTC(2024 + (i % 3), i % 12, 1 + (i % 27), 12)).toISOString(),
        filename: names[i % 6] + ' ' + i + (i % 5 === 0 ? '.mp4' : '.jpg'),
        originalPath:
          '/Pictures/Switzerland/' + names[i % 6] + ' ' + i + (i % 5 === 0 ? '.mp4' : '.jpg'),
        type: i % 5 === 0 ? 'video' : 'photo',
        hasThumbnail: true,
        thumbnailUrl: '/fixture/' + i,
        fileMtime: 1,
      }));
      const snapshot = {
        items,
        folders: size ? [{ path: '/Pictures/Switzerland', name: 'Switzerland', count: size }] : [],
        summary: {
          total: size,
          located: size,
          withoutGPS: 0,
          photos: size * 0.8,
          videos: size * 0.2,
        },
      };
      const events = {};
      window.__events = events;
      window.__snapshot = snapshot;
      window.photoMap = {
        getLibrary: async () => snapshot,
        addFolders: async () => {
          snapshot.folders = [{ path: '/Pictures/Switzerland', name: 'Switzerland', count: 0 }];
          return snapshot;
        },
        removeFolder: async () => ({
          items: [],
          folders: [],
          summary: { total: 0, located: 0, withoutGPS: 0 },
        }),
        startScan: async () => {
          events.progress?.({
            processed: 10,
            discovered: 10,
            added: 2,
            currentFile: 'A new memory.jpg',
          });
        },
        cancelScan: async () =>
          events.complete?.({
            phase: 'cancelled',
            summary: snapshot.summary,
            folders: snapshot.folders,
            skipped: 0,
            added: 0,
            errors: 0,
          }),
        getPreview: async (id) => ({ image: '/fixture/' + parseInt(id, 16), video: null }),
        reveal: async () => {},
        openOriginal: async () => {},
        openMaps: async () => {},
        onChanges: (fn) => {
          events.changes = fn;
        },
        onProgress: (fn) => {
          events.progress = fn;
        },
        onComplete: (fn) => {
          events.complete = fn;
        },
        onError: (fn) => {
          events.error = fn;
        },
      };
    },
    { size },
  );
  await page.goto('/renderer/index.html');
  await expect(page.locator('#located-total')).toHaveText(size.toLocaleString());
  await page.waitForFunction(() => typeof atlas !== 'undefined' && !atlas.loadBusy);
  return errors;
}
test('clear first-run experience, folder picker flow, scan cancellation and visible errors', async ({
  page,
}) => {
  const errors = await setup(page, 0);
  await expect(page.getByText('Your next journey starts here.')).toBeVisible();
  await page.screenshot({ path: 'test-results/empty-state.png' });
  await page.getByRole('button', { name: 'Choose your first folder' }).click();
  await expect(page.locator('#scan-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add photos', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop scan' }).click();
  await expect(page.locator('#scan-panel')).toBeHidden();
  await expect(page.locator('#status-text')).toContainText('Progress saved');
  await page.evaluate(() => window.__events.error('The drive is not available'));
  await expect(page.getByRole('alert')).toContainText('The drive is not available');
  expect(errors).toEqual([]);
});
test('map, media filter, empty heatmap, date range, live updates and reset', async ({ page }) => {
  const errors = await setup(page);
  await page.locator('[data-type="video"]').click();
  await expect(page.locator('#visible-count')).toHaveText('36');
  await page.locator('#date-from').fill('2026-01-01');
  await page.locator('#date-from').dispatchEvent('change');
  await expect(page.locator('#visible-count')).toHaveText('12');
  await page.locator('#reset-filters').click();
  await page.evaluate(() => atlas.map.setZoom(3));
  await expect.poll(() => page.evaluate(() => atlas.map.hasLayer(atlas.heat))).toBe(true);
  await page.locator('#search').fill('does-not-exist');
  await expect(page.locator('#visible-count')).toHaveText('0');
  await expect.poll(() => page.evaluate(() => atlas.map.hasLayer(atlas.heat))).toBe(false);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.evaluate(() =>
    window.__events.changes({
      upsert: [
        {
          ...window.__snapshot.items[1],
          id: 'ffffffffffffffffffffffffffffffff',
          lat: 0,
          lng: 0,
          date: '2030-01-01T12:00:00Z',
        },
      ],
      remove: [],
    }),
  );
  await expect(page.locator('#visible-count')).toHaveText('181');
  await expect(page.locator('#date-to')).toHaveValue('2030-01-01');
  expect(errors).toEqual([]);
});
test('large gallery is virtualized and viewer navigation is stable during live updates', async ({
  page,
}) => {
  const errors = await setup(page, 10000);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await expect(page.locator('#gallery-scroll .gallery-card').first()).toBeVisible();
  expect(await page.locator('#gallery-scroll .gallery-card').count()).toBeLessThan(60);
  await page.locator('#gallery-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('#gallery-scroll [data-index="9999"]')).toBeVisible();
  await page.locator('#gallery-scroll [data-index="9999"]').click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await expect(page.locator('#viewer-position')).toContainText('10000 / 10,000');
  const filename = await page.locator('#viewer-name').textContent();
  await page.evaluate(() =>
    window.__events.changes({
      upsert: [{ ...window.__snapshot.items[1], id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }],
      remove: [],
    }),
  );
  await expect(page.locator('#visible-count')).toHaveText('10,001');
  await expect(page.locator('#viewer-name')).toHaveText(filename);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#viewer-position')).toContainText('1 / 10,000');
  await page.keyboard.press('Escape');
  await expect(page.locator('#lightbox')).toBeHidden();
  expect(errors).toEqual([]);
});
test('cluster browsing, gallery, dialogs and compact window layout', async ({ page }) => {
  const errors = await setup(page);
  await expect(page.locator('.cluster-pin').first()).toBeVisible();
  await page.locator('.cluster-pin').first().click();
  await expect(page.locator('#area-panel')).toBeVisible();
  await page.locator('#area-close').click();
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.screenshot({ path: 'test-results/gallery.png' });
  await page.locator('#gallery-scroll .gallery-card').first().click();
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await page.screenshot({ path: 'test-results/viewer.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Help & shortcuts' }).click();
  await expect(page.locator('#help-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remove folder Switzerland', exact: true }).click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep folder' }).click();
  await page.setViewportSize({ width: 900, height: 640 });
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('#timeline')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/compact.png' });
  expect(errors).toEqual([]);
});
test('map visual review at desktop size', async ({ page }) => {
  const errors = await setup(page, 180, true);
  // Allow imagery to arrive; no behavior assertion depends on the remote service.
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'test-results/map.png' });
  expect(errors).toEqual([]);
});
