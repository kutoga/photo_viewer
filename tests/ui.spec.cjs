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

test('cluster near the map edge opens with one physical click', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(() => {
    atlas.map.setView([47.4, 9.6], 12, { animate: false });
    const position = atlas.map.containerPointToLatLng([6, 200]);
    atlas.setItems(
      window.__snapshot.items
        .slice(0, 3)
        .map((p) => ({ ...p, lat: position.lat, lng: position.lng })),
    );
  });
  await expect(page.locator('.cluster-pin')).toHaveCount(1);
  const center = await page.locator('.cluster-pin').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(center.x, center.y);
  await expect(page.locator('#area-panel')).toBeVisible();
  await expect(page.locator('#area-count')).toHaveText('3 memories to rediscover');
  expect(errors).toEqual([]);
});

test('a visible cluster keeps its own members while a newer index is loading', async ({ page }) => {
  const errors = await setup(page);
  const expected = await page.evaluate(async () => {
    const marker = [...atlas.markers.entries()].find(([key]) => key.startsWith('c'))[1];
    const count = Number(marker.getElement().textContent);
    // Hold the displayed markers while a new index containing different clusters is built.
    atlas.query = () => {};
    atlas.setItems(window.__snapshot.items.slice(0, 6));
    await new Promise((resolve) => {
      const poll = () => (atlas.loadBusy ? setTimeout(poll, 10) : resolve());
      poll();
    });
    marker.fire('click');
    return count;
  });
  await expect(page.locator('#area-panel')).toBeVisible();
  await expect(page.locator('#area-count')).toHaveText(`${expected} memories to rediscover`);
  expect(errors).toEqual([]);
});

test('fullscreen map uses the entire window and exits with its button, Escape, and F11', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.getByRole('button', { name: 'Fullscreen map', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rect = document.getElementById('map').getBoundingClientRect();
        return (
          Math.round(rect.width) === innerWidth &&
          Math.round(rect.height) === innerHeight &&
          rect.x === 0 &&
          rect.y === 0
        );
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Browse this area' }).click();
  await page.locator('#area-scroll .gallery-card').first().click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await page.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.keyboard.press('F11');
  await expect(page.locator('body')).toHaveClass(/map-fullscreen/);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/map-fullscreen/);
  await page.keyboard.press('F11');
  await expect(page.locator('body')).toHaveClass(/map-fullscreen/);
  await page.keyboard.press('F11');
  await expect(page.locator('.sidebar')).toBeVisible();
  expect(errors).toEqual([]);
});

test('library sorting stays off the UI thread and map rebuilding pauses in gallery during import', async ({
  page,
}) => {
  const errors = await setup(page, 50000);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  const version = await page.evaluate(() => atlas.version);
  await page.evaluate(() => {
    // Regression guard: bulk library operations must execute in the worker, not this thread.
    PhotoModel.filter =
      PhotoModel.sort =
      PhotoModel.dateBounds =
        () => {
          throw new Error('Bulk library work ran on the UI thread');
        };
    window.__events.progress({ processed: 50000, added: 0 });
    window.__batch = 0;
    window.__import = setInterval(() => {
      const batch = ++window.__batch;
      window.__events.changes({
        upsert: Array.from({ length: 100 }, (_, i) => ({
          ...window.__snapshot.items[i],
          id: (50000 + batch * 100 + i).toString(16).padStart(32, '0'),
        })),
        remove: [],
      });
    }, 100);
  });
  await page.locator('#search').fill('Summer days');
  await expect(page.locator('#visible-count')).not.toHaveText('50,000');
  await page.locator('#gallery-scroll .gallery-card').first().click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#viewer-position')).toContainText('2 /');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Stop scan' }).click();
  await page.evaluate(() => clearInterval(window.__import));
  await expect(page.locator('#scan-panel')).toBeHidden();
  expect(await page.evaluate(() => atlas.version)).toBe(version);
  expect(await page.locator('#gallery-scroll .gallery-card').count()).toBeLessThan(60);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect.poll(() => page.evaluate(() => atlas.version)).toBeGreaterThan(version);
  expect(errors).toEqual([]);
});
