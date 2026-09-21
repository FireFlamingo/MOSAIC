import { test, expect } from './fixture';

test('policy thresholds accept ordinary keyboard entry', async ({ page }) => {
  await page.getByRole('button', { name: 'Policy', exact: true }).click();
  const deny = page.getByRole('spinbutton', { name: /Deny the request/ });
  await deny.fill('');
  await deny.pressSequentially('80');
  await expect(deny).toHaveValue('80');
});

test('total metric leaves the review queue and displays all requests', async ({ page }) => {
  await page.getByRole('button', { name: /Review queue/ }).click();
  await page.getByRole('button', { name: /Evaluated artifacts/ }).click();
  await expect(page.getByRole('heading', { name: 'All requests' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(10);
});

test('decision metric clears incompatible artifact and search filters', async ({ page }) => {
  await page.getByRole('group', { name: 'Artifact type filter' }).getByRole('button', { name: /Packages/ }).click();
  await page.getByRole('textbox', { name: 'Search requests' }).fill('no-match');
  await page.locator('.metric.review').click();
  await expect(page.locator('tbody')).toContainText('mail-triage-lab');
});

test('inspect session shortcut opens and focuses the session chooser', async ({ page }) => {
  await page.getByRole('button', { name: 'Inspect a session' }).click();
  await expect(page.getByRole('combobox', { name: 'Choose session' })).toBeFocused();
});
