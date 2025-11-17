// src/playwright-test.mjs
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log('title:', await page.title());
  await browser.close();
})();
