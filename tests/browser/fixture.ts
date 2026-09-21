import { test as base, expect } from '@playwright/test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../../server/index';

export const test = base.extend({
  baseURL: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'mosaic-browser-'));
    const { app } = await createApp({ dataDir: directory });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server has no port');
    try { await use(`http://127.0.0.1:${address.port}`); }
    finally {
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('mosaic-browser-')) throw new Error('Unexpected test data path');
      await rm(directory, { recursive: true, force: true });
    }
  },
  page: async ({ page }, use) => {
    await page.goto('/');
    await expect(page.getByText('API reachable', { exact: true })).toBeVisible();
    await use(page);
  },
});
export { expect };
