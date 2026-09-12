const { chromium, expect } = require('../../apps/desktop/node_modules/@playwright/test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
(async () => {
  const output = path.resolve(process.argv[2] || '');
  if (!output.startsWith('E:\\Workspaces\\_verification\\') || !fs.statSync(output).isDirectory()) throw Error('Existing isolated output directory required');
  const browser = await chromium.launch({ channel:'msedge', headless:true });
  const page = await browser.newPage({ viewport:{ width:1440,height:1000 } });
  const errors=[]; page.on('pageerror',error=>errors.push(String(error)));
  try {
    await page.goto(pathToFileURL(path.resolve('docs/mobius-guide.html')).href);
    await expect(page.locator('.node')).toHaveCount(4);
    await page.locator('[data-node=b]').click();
    let graph=JSON.parse(await page.locator('#graph-json').textContent());
    if (graph.nodes.map(n=>n.session_id).join(',')!=='demo-a,demo-b') throw Error('Sibling leaked into ancestry');
    await page.locator('#merge').click();
    graph=JSON.parse(await page.locator('#graph-json').textContent());
    if (graph.nodes.length!==3 || graph.nodes.some(n=>n.session_id==='demo-d')) throw Error('Invalid merge preview');
    await page.locator('[data-node=d]').click();
    graph=JSON.parse(await page.locator('#graph-json').textContent());
    if (graph.nodes.length!==4 || graph.edges.length!==4) throw Error('Incomplete ancestor union');
    await page.getByRole('tab',{name:'CLI 命令行',exact:true}).click();
    await expect(page.locator('#cli')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#mcp')).toBeVisible();
    for (const id of ['mcp-config','mcp-approval','mcp-read','mcp-graph']) JSON.parse(await page.locator('#'+id).textContent());
    await page.locator('[data-copy=mcp-config]').click();
    await expect(page.locator('#copy-status')).toContainText(/已复制|已选中/);
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      for (const id of ['desktop','cli','mcp']) {
        await page.locator('#tab-'+id).click();
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
        if (overflow) throw Error(`Horizontal page overflow at ${width}/${id}`);
      }
      await page.locator('#tab-desktop').click();
      await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:path.join(output,`guide-${width}.png`),fullPage:true});
    }
    if(errors.length)throw Error(errors.join('\n'));
    console.log(JSON.stringify({passed:true,checks:['branch exclusion','merge deduplication','four-node ancestry','three tabs','keyboard navigation','copy or fallback','valid JSON examples','desktop/mobile no page overflow','no JS errors']}));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
