// Opt-in real desktop runner. No mocks, injected backend calls or existing project writes.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = 'E:/Workspaces/Mobius-Verification-20260908-real';
const evidence = process.env.MOBIUS_REAL_EVIDENCE || 'D:/AcceptedArtifacts/Mobius-Verification-20260908-real';
const workspace = root.replaceAll('/', '\\') + '\\workspace';
async function main() {
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.connectOverCDP(process.env.MOBIUS_REAL_CDP || 'http://127.0.0.1:9348');
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  const stage = process.argv[2];
  try {
    if (stage === 'setup') {
      await page.getByRole('button', { name: '继续', exact: true }).click();
      await page.screenshot({ path: path.join(evidence, 'onboarding-sources.png') });
      console.log(await page.locator('body').innerText());
    } else if (stage === 'register') {
      const skip = page.getByRole('button', { name: '跳过引导，查看工程', exact: true });
      if (await skip.isVisible()) await skip.click();
      await page.locator('.atlas-add').click();
      const dialog = page.locator('.mobius-modal[role=dialog]');
      await dialog.locator('input').fill(workspace);
      await dialog.locator('button.primary-button').click();
      await page.getByRole('button', { name: '新建 PowerShell', exact: true }).click();
      await page.locator('.terminal-stage .xterm-helper-textarea').waitFor({ state: 'attached' });
      await page.screenshot({ path: path.join(evidence, 'real-powershell-created.png') });
    } else if (stage === 'new-terminal') {
      await page.getByRole('button', { name: '工作区', exact: true }).click();
      await page.getByRole('button', { name: '新建 PowerShell', exact: true }).click();
      await page.locator('.terminal-stage .xterm-helper-textarea').waitFor({ state: 'attached' });
    } else if (stage === 'command') {
      const command = process.argv[3];
      if (!command || command.includes('\n')) throw new Error('one reviewed command required');
      const input = page.locator('.terminal-stage .xterm-helper-textarea');
      await input.focus();
      await page.keyboard.insertText(command);
      await page.keyboard.press('Enter');
    } else if (stage === 'all-terminals') {
      const count = await page.locator('.terminal-tab-select').count();
      for (let index = 0; index < count; index++) {
        await page.locator('.terminal-tab-select').nth(index).click();
        await page.locator('.terminal-stage .xterm-helper-textarea').waitFor({ state: 'attached' });
        await page.screenshot({ path: path.join(evidence, `terminal-${index}.png`) });
        const text = await page.locator('body').innerText();
        fs.writeFileSync(path.join(evidence, `terminal-${index}.txt`), text, 'utf8');
        console.log(JSON.stringify({ index, tail: text.slice(-4500) }));
      }
    } else if (stage === 'graph') {
      await page.locator('.rail-item').nth(0).click();
      const show = page.getByRole('button', { name: '工作区', exact: true });
      if (await show.isVisible()) await show.click();
      await page.locator('.atlas-project-button').and(page.getByTitle(workspace, { exact: true })).click();
      await page.getByRole('button', { name: '交接图' }).click();
      await page.locator('.relay-edge').first().waitFor();
      await page.locator('.relay-edge').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, 'real-handoff-graph.png') });
      console.log(await page.locator('.workspace-relay-graph').innerText());
    } else if (stage === 'source') {
      const source = page.locator('.session-sources-dialog');
      if (!await source.isVisible()) {
        await page.locator('.rail-item').nth(1).click();
        await page.getByRole('button', { name: '来源', exact: true }).click();
      }
      await source.getByLabel('Agent provider').selectOption(process.argv[3]);
      await source.locator('.source-add input').fill(process.argv[4]);
      await source.getByRole('button', { name: '添加来源', exact: true }).click();
      console.log('Source submitted through UI');
    } else if (stage === 'scan') {
      await page.locator('.rail-item').nth(1).click();
      await page.getByRole('button', { name: '扫描会话', exact: true }).click();
    } else if (stage === 'resume') {
      const reader = page.locator('.session-reader-v2');
      if ((await reader.locator('dl dd').last().innerText()).trim() !== process.argv[3]) throw new Error('Selected native session identity does not match');
      await reader.getByRole('button', { name: '继续原会话', exact: true }).click();
    } else if (stage === 'handoff') {
      const reader = page.locator('.session-reader-v2');
      if ((await reader.locator('dl dd').last().innerText()).trim() !== process.argv[3]) throw new Error('Wrong native handoff source');
      const target = process.argv[4] || 'claude';
      const targetLabel = {codex:'Codex', claude:'Claude', pi:'Pi', grok:'Grok'}[target];
      await reader.locator('.message-stream-v2 article').filter({ hasText: process.argv[5] || 'video buffer chosen as 3 frames' }).click();
      await reader.getByRole('button', { name: '交接给其他 Agent', exact: true }).click();
      const dialog = page.locator('.mobius-modal[role=dialog]');
      await dialog.getByLabel('目标 Agent').selectOption(target);
      await dialog.getByRole('button', { name: '生成完整轨迹预览', exact: true }).click();
      await dialog.locator('.trajectory-review input[type=checkbox]').check();
      await page.screenshot({ path: path.join(evidence, 'real-handoff-review.png') });
      await dialog.getByRole('button', { name: `打开 ${targetLabel} 并交接`, exact: true }).click();
    } else if (stage === 'find') {
      if (await page.locator('.session-sources-dialog').isVisible()) await page.keyboard.press('Escape');
      await page.locator('.rail-item').nth(1).click();
      await page.locator('.session-tree-v2').getByRole('button', { name: '全部会话', exact: true }).click();
      await page.locator('.session-search-v2 input').fill(process.argv[3]);
      await page.locator('.session-list-row').first().waitFor();
      let found = false;
      for (let attempt = 0; attempt < 30 && !found; attempt++) {
        const rows = page.locator('.session-list-row');
        for (let index = 0; index < await rows.count(); index++) {
          await rows.nth(index).click();
          if ((await page.locator('.session-reader-v2 dl dd').last().innerText()).trim() === process.argv[3]) { found = true; break; }
        }
        if (!found) await page.waitForTimeout(200);
      }
      if (!found) throw new Error('Exact native ID was not found; transcript mentions are not session identity');
      await page.screenshot({ path: path.join(evidence, 'real-session-found.png') });
      console.log((await page.locator('body').innerText()).slice(-5500));
    } else if (stage === 'terminal') {
      await page.locator('.terminal-tab-select').nth(Number(process.argv[3])).click();
    } else if (stage === 'snapshot') {
      const tag = process.argv[3] || 'current';
      if (!/^[a-z0-9-]+$/.test(tag)) throw new Error('invalid artifact tag');
      await page.screenshot({ path: path.join(evidence, `${tag}.png`) });
      const text = await page.locator('body').innerText();
      fs.writeFileSync(path.join(evidence, `${tag}.txt`), text, 'utf8');
      console.log(text.slice(-10000));
    } else throw new Error('Unknown stage');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
