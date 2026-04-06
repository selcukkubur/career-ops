import { chromium } from 'playwright';

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    proxy: {
        server: 'brd.superproxy.io:33335',
        username: 'brd-customer-hl_c6f2e53b-zone-web_unlocker1',
        password: 'ozi8ewbh2o1j',
    },
    ignoreDefaultArgs: ['--disable-extensions'],
});

const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

console.log('Navigating to Lever apply page...');
await page.goto('https://jobs.lever.co/mistral/2a357282-9d44-4b41-a249-c75ffe878ce2/apply', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

// Fill some basic fields
console.log('Filling form fields...');
await page.fill('input[name="name"]', 'Test User');
await page.fill('input[name="email"]', 'test@test.com');
await page.fill('input[name="phone"]', '+1234567890');
await page.fill('input[name="location"]', 'Test City');
await page.fill('input[name="org"]', 'Test Org');
await page.fill('input[name="urls[LinkedIn]"]', 'https://linkedin.com/in/test');
await page.fill('textarea[name="comments"]', 'Test comment');

// Upload resume
await page.setInputFiles('input[type="file"][name="resume"]', '/app/SK_Resume.pdf');

await page.waitForTimeout(2000);

// Take pre-submit screenshot
await page.screenshot({ path: '/app/output/debug-pre-submit.png', fullPage: true });
console.log('Pre-submit screenshot saved');

// Find all buttons
const buttons = await page.$$eval('button', btns => btns.map(b => ({ text: b.textContent.trim(), visible: b.offsetParent !== null })));
console.log('All buttons:', buttons);

// Find submit button
const submitBtn = await page.$('button[type="submit"]');
if (submitBtn) {
    console.log('Found button[type="submit"]');
}

// Try text-based submit
const submitBtns = await page.$$('button');
for (const btn of submitBtns) {
    const text = await btn.textContent();
    if (text.toLowerCase().includes('submit')) {
        console.log('Found submit button by text:', text);
        const isVisible = await btn.isVisible();
        console.log('Is visible:', isVisible);

        await btn.click();
        console.log('Clicked submit button');
        break;
    }
}

// Wait for navigation or response
await page.waitForTimeout(15000);

// Check for errors
const errors = await page.evaluate(() => {
    const errs = [];
    document.querySelectorAll('.error, [class*="error"], [class*="invalid"], .field-error').forEach(el => {
        if (el.offsetParent !== null) errs.push(el.textContent.trim());
    });
    return errs;
});
console.log('Errors after submit:', errors);

// Check page state
const url = page.url();
const title = await page.title();
const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
console.log('URL:', url);
console.log('Title:', title);
console.log('Body preview:', bodyText.substring(0, 300));

await page.screenshot({ path: '/app/output/debug-post-submit.png', fullPage: true });
console.log('Post-submit screenshot saved');

await browser.close();