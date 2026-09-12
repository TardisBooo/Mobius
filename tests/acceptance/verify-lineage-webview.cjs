// Real isolated Tauri WebView + real core IPC, with fictional fixture sessions.
// No Harness is launched by this UI regression check.
const { chromium, expect } = require('../../apps/desktop/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = path.resolve(process.argv[2] || '');
  if (!root.startsWith('E:\\Workspaces\\_verification\\') || !fs.existsSync(path.join(root, 'vault', 'mobius.sqlite'))) throw Error('Isolated fixture required');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9337');
  const page = browser.contexts()[0].pages()[0];
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto('http://localhost:1420/');
    await page.evaluate(() => {
      localStorage.setItem('mobius.onboarding.complete', '1');
      localStorage.setItem('mydesk.locale.v2', 'en');
    });
    await page.reload();
    await expect(page.locator('.workspace-atlas')).toBeVisible({ timeout: 20000 });
    const health = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('health'));
    if (!health.database_path.startsWith(root)) throw Error('Wrong desktop vault');
    await page.getByText('Lineage acceptance fixture', { exact: true }).first().click();
    await page.getByRole('button', { name: /Handoff graph/ }).click();
    await expect(page.locator('.lineage-node')).toHaveCount(4);
    const target = page.locator('.lineage-node[data-id="fixture-d"]');
    await target.click();
    await expect(page.locator('.lineage-node.ancestor')).toHaveCount(4);
    await expect(page.getByRole('complementary', { name: 'Node details' })).toContainText('native-d');
    const alias = `Verification merge ${Date.now()}`;
    await page.getByLabel('Display name (Mobius only)').fill(alias);
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(target).toContainText(alias);
    const stored = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('session_lineage', { sessionIds: ['fixture-d'] }));
    if (stored.nodes.find(n => n.session_id === 'fixture-d').title !== alias) throw Error('Alias was not persisted');
    const before = await target.boundingBox();
    await page.mouse.move(before.x + 40, before.y + 40);
    await page.mouse.down(); await page.mouse.move(before.x + 90, before.y + 80, { steps: 12 }); await page.mouse.up();
    await expect.poll(async () => (await target.boundingBox()).x).toBeGreaterThan(before.x + 20);
    await target.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Inspect session' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select source: native-b', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select source: native-c', exact: true }).check();
    await page.getByRole('button', { name: 'Hand off selected sources (2)' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('references_only');
    await expect(dialog).toContainText('fixture-a');
    await expect(dialog).not.toContainText('fixture-d');
    await expect(dialog.getByRole('button', { name: 'Create session and hand off', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await expect(dialog.getByRole('button', { name: 'Create session and hand off', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    for (const theme of ['light', 'dark']) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) {
        await page.getByRole('button', { name: 'Switch theme', exact: true }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).not.toHaveClass(/mobius-theme-switching/);
      await page.screenshot({ path: path.join(root, `lineage-${theme}.png`) });
      const contrast = await target.evaluate(el => ({ fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
      if (contrast.fg === contrast.bg) throw Error(`Invisible node in ${theme}`);
    }
    if (errors.length) throw Error(errors.join('\n'));
    console.log(JSON.stringify({ passed: true, layer: 'real Tauri IPC + WebView, fictional sessions', checks: ['four nodes', 'ancestry', 'persistent alias', 'drag', 'context menu', 'multi-source graph review', 'explicit confirmation', 'light/dark'], fixture: root }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
