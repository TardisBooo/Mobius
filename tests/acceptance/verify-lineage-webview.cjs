// Real isolated Tauri WebView + real core IPC, with fictional fixture sessions.
// No Harness is launched by this UI regression check.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function loadReceipt(root) {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'launch-receipt.json'), 'utf8'));
  if (path.resolve(receipt.Fixture) !== path.resolve(root)) throw Error('Launch receipt uses another fixture');
  if (!['source', 'candidate', 'installed'].includes(receipt.Layer)) throw Error('Acceptance layer is required');
  if (!Number.isInteger(receipt.ProcessId) || receipt.ProcessId <= 0) throw Error('Launch process is required');
  if (!Number.isInteger(receipt.Port) || receipt.Port < 9300 || receipt.Port > 9399) throw Error('Invalid verification port');
  if (path.resolve(receipt.Profile) !== path.resolve(root, 'webview')) throw Error('Wrong WebView profile');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(receipt.Executable)).digest('hex');
  if (digest !== receipt.BinarySha256) throw Error('Launched binary changed after the receipt');
  if (receipt.Layer === 'installed' && !/^E:\\SOFTWARE\\/i.test(receipt.Executable)) throw Error('Installed acceptance requires the maintained executable');
  return receipt;
}

function checkPageUrl(url, layer) {
  const parsed = new URL(url);
  if (['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && layer !== 'source') {
    throw Error('A development server cannot verify candidate or installed frontend assets');
  }
  if (url === 'about:blank') throw Error('The application entry page has not loaded');
  if (layer !== 'source' && !['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'].includes(parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin)) throw Error('Candidate and installed checks require packaged application assets');
}

function verifyPortOwner(receipt) {
  const command = `$ownerPid = @(Get-NetTCPConnection -State Listen -LocalPort ${receipt.Port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique); if ($ownerPid.Count -ne 1) { throw 'Ambiguous debugging port owner' }; $current = $ownerPid[0]; for ($i=0; $i -lt 16 -and $current -gt 0; $i++) { if ($current -eq ${receipt.ProcessId}) { Write-Output 'owned'; exit 0 }; $current = (Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop).ParentProcessId }; throw 'Debugging port does not belong to the launched application'`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
}

module.exports = { loadReceipt, checkPageUrl };

async function main() {
  const { chromium, expect } = require(require.resolve('@playwright/test', { paths: [path.resolve(__dirname, '../../apps/desktop'), process.env.MOBIUS_PLAYWRIGHT_ROOT].filter(Boolean) }));
  const root = path.resolve(process.argv[2] || '');
  if (!root.startsWith('E:\\Workspaces\\_verification\\') || !fs.existsSync(path.join(root, 'vault', 'mobius.sqlite'))) throw Error('Isolated fixture required');
  let receipt = loadReceipt(root);
  const runningPath = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${receipt.ProcessId} -ErrorAction Stop).Path`], { encoding: 'utf8' }).trim();
  if (path.resolve(runningPath).toLowerCase() !== path.resolve(receipt.Executable).toLowerCase()) throw Error('Receipt does not identify the running executable');
  verifyPortOwner(receipt);
  let browser = await chromium.connectOverCDP(`http://127.0.0.1:${receipt.Port}`);
  const pages = browser.contexts().flatMap(context => context.pages());
  if (pages.length !== 1) throw Error(`Expected one isolated application page, found ${pages.length}`);
  let page = pages[0];
  const entryUrl = page.url();
  checkPageUrl(entryUrl, receipt.Layer);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.evaluate(() => {
      localStorage.setItem('mobius.onboarding.complete', '1');
      localStorage.setItem('mobius.locale.v2', 'en');
    });
    await page.reload();
    await page.getByRole('button', { name: 'Lineage acceptance fixture', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Selected project', exact: true })).toBeVisible({ timeout: 20000 });
    const health = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('health'));
    if (!health.database_path.startsWith(root)) throw Error('Wrong desktop vault');
    await page.getByRole('button', { name: /Handoff graph/ }).click();
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(page.locator('.lineage-node')).toHaveCount(4);
    let target = page.locator('.lineage-node[data-id="fixture-d"]');
    await target.click();
    await expect(page.locator('.lineage-node.ancestor')).toHaveCount(4);
    await expect(page.getByRole('complementary', { name: 'Node details' })).toContainText('native-d');
    if (!(await page.locator('.lineage-metadata').evaluate(el => el.open))) {
      await page.locator('.lineage-metadata > summary').click();
    }
    const alias = `Verification merge ${Date.now()}`;
    await page.getByLabel('Display name (Mobius only)').fill(alias);
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(target).toContainText(alias);
    const stored = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('session_lineage', { sessionIds: ['fixture-d'] }));
    if (stored.nodes.find(n => n.session_id === 'fixture-d').title !== alias) throw Error('Alias was not persisted');
    const secondAlias = `${alias} second operation`;
    await page.getByLabel('Display name (Mobius only)').fill(secondAlias);
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(target).toContainText(secondAlias);
    await page.reload();
    if (page.url() !== entryUrl) throw Error('Acceptance left the delivered entry point');
    await page.getByRole('button', { name: 'Lineage acceptance fixture', exact: true }).click();
    await page.getByRole('button', { name: /Handoff graph/ }).click();
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    await expect(target).toContainText(secondAlias);
    const reopened = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('session_lineage', { sessionIds: ['fixture-d'] }));
    if (reopened.nodes.find(n => n.session_id === 'fixture-d').title !== secondAlias) throw Error('Second alias was lost after reopening the page');
    await browser.close();
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${receipt.ProcessId} -ErrorAction SilentlyContinue; Wait-Process -Id ${receipt.ProcessId} -Timeout 10 -ErrorAction SilentlyContinue`]);
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'start-lineage-desktop.ps1'), '-FixtureRoot', root, '-Executable', receipt.Executable, '-Layer', receipt.Layer, '-Port', String(receipt.Port)], { encoding: 'utf8' });
    const firstLaunch = receipt;
    receipt = loadReceipt(root);
    if (receipt.BinarySha256 !== firstLaunch.BinarySha256 || receipt.Profile !== firstLaunch.Profile) throw Error('Application restart changed binary or profile');
    await expect.poll(() => {
      try { verifyPortOwner(receipt); return true; } catch { return false; }
    }, { timeout: 20000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${receipt.Port}`);
    page = browser.contexts()[0].pages()[0];
    page.on('pageerror', e => errors.push(String(e)));
    if (page.url() !== entryUrl) throw Error('Restart changed the delivered entry point');
    await page.getByRole('button', { name: 'Lineage acceptance fixture', exact: true }).click();
    await page.getByRole('button', { name: /Handoff graph/ }).click();
    await page.getByRole('button', { name: 'Graph', exact: true }).click();
    target = page.locator('.lineage-node[data-id="fixture-d"]');
    await expect(target).toContainText(secondAlias);
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
    await page.getByRole('button', { name: 'Handoff sources 2' }).click();
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
    console.log(JSON.stringify({ passed: true, layer: receipt.Layer, launch: receipt, entry_url: entryUrl, scope: 'lineage regression with fictional sessions', application_restart: 'passed', checks: ['four nodes', 'ancestry', 'persistent alias', 'second alias after page reopen', 'drag', 'context menu', 'multi-source graph review', 'explicit confirmation', 'light/dark'], fixture: root }));
  } finally { await browser.close(); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
