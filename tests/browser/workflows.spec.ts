import { readFile } from 'node:fs/promises';
import { test, expect } from './fixture';
import type { AppState, Evaluation } from '../../shared/types';

for (const [label, type] of [['Package', 'package'], ['Skill', 'skill'], ['MCP server', 'mcp'], ['Remote URL', 'url']]) {
  test(`evaluate ${label} with dropdown evidence and inspect its receipt`, async ({ page }) => {
    await page.getByRole('button', { name: /New evaluation/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Artifact name', exact: true }).fill('browser-fixture');
    await dialog.getByRole('textbox', { name: 'Session ID' }).fill('browser-session');
    await dialog.getByRole('textbox', { name: type === 'url' ? 'URL to evaluate' : 'Source', exact: true }).fill('https://example.invalid/docs');
    const exists = dialog.getByRole('combobox', { name: 'Artifact existence' });
    await exists.focus();
    await exists.press('Home');
    await exists.press('ArrowDown');
    await exists.press('Tab');
    await expect(exists).toHaveValue('true');
    await dialog.getByRole('combobox', { name: 'Signature', exact: true }).selectOption('false');
    await dialog.getByRole('spinbutton', { name: 'Age in days' }).fill('100');
    await dialog.getByRole('spinbutton', { name: 'Downloads' }).fill('1000');
    await dialog.getByText('Content & permissions', { exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Static content' }).fill('Read the selected project documentation.');
    await dialog.getByRole('checkbox', { name: 'read:workspace', exact: true }).check();
    const response = page.waitForResponse(r => r.url().endsWith('/api/evaluate') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Evaluate request' }).click();
    const result = await response;
    expect(result.status()).toBe(201);
    const evaluation: Evaluation = await result.json();
    expect(evaluation.request.type).toBe(type);
    expect(evaluation.request.metadata).toMatchObject({ exists: true, signed: false, ageDays: 100, downloads: 1000, permissions: ['read:workspace'] });
    expect(evaluation.score).toBe(10);
    await expect(page.getByRole('dialog', { name: 'Evaluation details' })).toBeVisible();
    await expect(dialog).toContainText(evaluation.receipt.hash);
    await dialog.getByText('Supplied metadata & content', { exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('"signed": false');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /New evaluation/ })).toBeFocused();
    await page.reload();
    await expect(page.locator('tbody')).toContainText('browser-fixture');
  });
}

for (const decision of ['allow', 'deny'] as const) {
  test(`human can ${decision} a held request and the result survives reload`, async ({ page }) => {
    await page.getByRole('button', { name: /Review queue/ }).click();
    await page.locator('tbody').getByRole('button', { name: 'Inspect mail-triage-lab', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const resolve = dialog.getByRole('button', { name: decision === 'allow' ? 'Allow request' : 'Deny request' });
    await expect(resolve).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Reviewer note' }).fill(`Browser verification: ${decision}`);
    await resolve.click();
    await expect(dialog.getByText(`Human review · ${decision === 'allow' ? 'Allowed' : 'Denied'}`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('tbody')).not.toContainText('mail-triage-lab');
    await page.reload();
    await page.getByRole('button', { name: 'Requests', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search requests' }).fill('mail-triage-lab');
    await expect(page.locator('tbody')).toContainText(decision === 'allow' ? 'Allowed' : 'Denied');
    await page.locator('tbody').getByRole('button', { name: 'Inspect mail-triage-lab', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(`Browser verification: ${decision}`);
  });
}

test('policy validates edits, saves with Enter, previews, discards, and persists', async ({ page }) => {
  await page.getByRole('button', { name: 'Policy', exact: true }).click();
  const review = page.getByRole('spinbutton', { name: /Hold for review/ });
  const deny = page.getByRole('spinbutton', { name: /Deny the request/ });
  await review.fill('90');
  await expect(page.getByRole('alert')).toContainText('Review must be lower');
  await expect(page.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(review).toHaveValue('35');
  await review.fill('0');
  await deny.fill('80');
  await page.getByRole('switch').click();
  await deny.press('Enter');
  await expect(page.getByRole('button', { name: 'Save policy' })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Policy updated');
  await page.getByRole('slider', { name: 'Preview risk score' }).fill('90');
  await expect(page.locator('.policy-preview')).toContainText('Denied');
  await page.reload();
  await page.getByRole('button', { name: 'Policy', exact: true }).click();
  await expect(review).toHaveValue('0');
  await expect(deny).toHaveValue('80');
  await expect(page.getByRole('switch')).not.toBeChecked();
  await deny.fill('85');
  await page.getByRole('button', { name: 'Refresh gateway state' }).click();
  await expect(page.getByRole('button', { name: 'Refresh gateway state' })).toBeEnabled();
  await expect(deny).toHaveValue('85');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(deny).toHaveValue('80');
});

test('workflow menu supports keyboard selection and clears old stream filters', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Replay workflow', exact: true });
  await trigger.click();
  await expect(page.locator('#workflow-menu button').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#workflow-menu button').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('textbox', { name: 'Search requests' }).fill('no-match');
  await trigger.click();
  await page.getByRole('button', { name: /Linked trust signals/ }).click();
  await expect(page.locator('.session-canvas .trace-node')).toHaveCount(2);
  await expect(page.locator('tbody')).toContainText('briefing-helper');
  await expect(page.getByRole('textbox', { name: 'Search requests' })).toHaveValue('');
  await page.getByRole('button', { name: 'View session', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('.session-filter')).toBeVisible();
  await page.getByRole('button', { name: 'Clear all filters' }).click();
  await expect(page.locator('.table-footer')).toContainText('of 12 observations');
});

test('all replay choices create the advertised decisions', async ({ page }) => {
  for (const [name, verdict] of [['Known publisher install', 'Allowed'], ['Young integration needs review', 'Needs review'], ['Over-privileged unknown source', 'Denied']]) {
    await page.getByRole('button', { name: 'Replay workflow', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.locator('.session-canvas .trace-node')).toHaveCount(1);
    await expect(page.locator('.session-canvas .trace-node')).toContainText(verdict);
  }
});

test('session dropdown and decision dropdown show the selected records', async ({ page, request, baseURL }) => {
  const state: AppState = await (await request.get(`${baseURL}/api/state`)).json();
  const target = state.evaluations.find(e => e.request.name === '@mosaic/ledger')!;
  await page.getByRole('combobox', { name: 'Choose session' }).selectOption(target.request.sessionId);
  await expect(page.locator('.session-canvas')).toContainText('@mosaic/ledger');
  await page.getByRole('button', { name: /Review queue/ }).click();
  await page.getByRole('combobox', { name: 'Filter by decision' }).selectOption('allow');
  await expect(page.getByRole('heading', { name: 'All requests' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(7);
  await page.getByRole('combobox', { name: 'Filter by decision' }).selectOption('deny');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Filter by decision' }).selectOption('review');
  await expect(page.locator('tbody tr')).toHaveCount(1);
});

test('search, type filters, pagination and keyboard shortcuts work together', async ({ page }) => {
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('.table-footer')).toContainText('7–10 of 10');
  await page.getByRole('group', { name: 'Artifact type filter' }).getByRole('button', { name: /Packages/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await page.keyboard.press('/');
  await expect(page.getByRole('textbox', { name: 'Search requests' })).toBeFocused();
  await page.keyboard.type('no-match');
  await expect(page.locator('tbody')).toContainText('No matching');
  await page.getByRole('button', { name: 'Clear all filters' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await page.keyboard.press('n');
  await expect(page.getByRole('dialog', { name: 'New evaluation' })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Evaluate request' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('audit download contains evaluations and receipts', async ({ page }) => {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export audit trail' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('mosaic-audit.json');
  const content = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(content.evaluations).toHaveLength(10);
  expect(content.evaluations[0].receipt.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(content.audit).toHaveLength(10);
});

test('failed submission preserves the form and can reconnect without closing', async ({ page }) => {
  await page.getByRole('button', { name: /New evaluation/ }).click();
  await page.getByRole('textbox', { name: 'Artifact name', exact: true }).fill('retained-draft');
  await page.route('**/api/evaluate', route => route.abort());
  await page.getByRole('button', { name: 'Evaluate request' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('draft is still here');
  await page.unroute('**/api/evaluate');
  await page.getByRole('dialog').getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Evaluate request' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Artifact name', exact: true })).toHaveValue('retained-draft');
  await page.getByRole('button', { name: 'Evaluate request' }).click();
  await expect(page.getByRole('dialog', { name: 'Evaluation details' })).toContainText('retained-draft');
});

test('mobile navigation, workflow menu, and evaluation form fit the screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Policy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Decision thresholds' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Replay workflow', exact: true }).click();
  await page.getByRole('button', { name: /Linked trust signals/ }).click();
  await expect(page.locator('.trace-node')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const toastFits = await page.getByRole('status').evaluate((node) => {
    for (const animation of node.getAnimations()) { animation.pause(); animation.currentTime = 90; }
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth;
  });
  expect(toastFits).toBe(true);
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /New evaluation/ }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('combobox', { name: 'Artifact existence' }).selectOption('false');
  await expect(modal.getByRole('combobox', { name: 'Artifact existence' })).toHaveValue('false');
  await page.getByRole('button', { name: 'Close dialog' }).click();
});

test('desktop visual checkpoint', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Replay workflow', exact: true }).click();
  await page.getByRole('button', { name: /Linked trust signals/ }).click();
  await expect(page.locator('.trace-node')).toHaveCount(2);
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true, animations: 'disabled' });
});

test('an unavailable gateway can reconnect from the main screen', async ({ page }) => {
  await page.route('**/api/state', route => route.abort());
  await page.getByRole('button', { name: 'Refresh gateway state' }).click();
  await expect(page.getByRole('button', { name: /New evaluation/ })).toBeDisabled();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await page.unroute('**/api/state');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: /New evaluation/ })).toBeEnabled();
  await expect(page.getByText('API reachable', { exact: true })).toBeVisible();
});

test('a rejected request keeps its draft and leaves the gateway usable', async ({ page }) => {
  await page.getByRole('button', { name: /New evaluation/ }).click();
  await page.getByRole('textbox', { name: 'Artifact name', exact: true }).fill('preserved-after-rejection');
  await page.route('**/api/evaluate', route => route.fulfill({ status: 400, json: { error: 'Test validation rejection' } }));
  await page.getByRole('button', { name: 'Evaluate request' }).click();
  await expect(page.getByRole('status')).toContainText('Test validation rejection');
  await expect(page.getByRole('textbox', { name: 'Artifact name', exact: true })).toHaveValue('preserved-after-rejection');
  await expect(page.getByRole('button', { name: 'Evaluate request' })).toBeEnabled();
  await page.unroute('**/api/evaluate');
  await page.getByRole('button', { name: 'Evaluate request' }).click();
  await expect(page.getByRole('dialog', { name: 'Evaluation details' })).toContainText('preserved-after-rejection');
});
