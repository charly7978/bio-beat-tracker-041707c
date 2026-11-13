import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 1) Splash → INICIAR SISTEMA
const startBtn = page.getByText('INICIAR SISTEMA');
if (await startBtn.count()) {
  await startBtn.click().catch(() => { });
  await page.waitForTimeout(2000);
}

// 2) Disclaimer → ACEPTAR Y CONTINUAR (por rol button; si falla, scroll y reintento)
const acceptBtn = page.getByRole('button', { name: /ACEPTAR/i }).first();
if (await acceptBtn.count()) {
  await acceptBtn.scrollIntoViewIfNeeded().catch(() => {});
  await acceptBtn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(2000);
  const gone = (await page.getByText('DESCARGO', { exact: false }).count()) === 0;
  console.log('DISCLAIMER_ACCEPTED:', gone ? 'yes' : 'no');
}

await page.screenshot({ path: 'shot-monitor-idle.png' });
console.log('CANVAS_COUNT:', await page.locator('canvas').count());
console.log('HAS_VIDEO:', await page.locator('video').count());
console.log('ERRORS:', errors.length ? errors.join(' | ') : 'none');

await browser.close();
