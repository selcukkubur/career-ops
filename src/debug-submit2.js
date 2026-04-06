import { chromium } from 'playwright';

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    proxy: {
        server: 'brd.superproxy.io:33335',
        username: 'brd-customer-hl_c6f2e53b-zone-web_unlocker1',
        password: 'ozi8ewbh2o1j',
    },
});

const page = await browser.newPage({ ignoreHTTPSErrors: true });

console.log('Navigating to Lever apply page...');
await page.goto('https://jobs.lever.co/mistral/2a357282-9d44-4b41-a249-c75ffe878ce2/apply', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

// Fill all fields
console.log('Filling form fields...');
await page.fill('input[name="name"]', 'Test User');
await page.fill('input[name="email"]', 'test@test.com');
await page.fill('input[name="phone"]', '+1234567890');
await page.fill('input[name="location"]', 'Test City');
await page.fill('input[name="org"]', 'Test Org');
await page.fill('input[name="urls[LinkedIn]"]', 'https://linkedin.com/in/test');
await page.fill('input[name="urls[Twitter]"]', 'https://twitter.com/test');
await page.fill('input[name="urls[GitHub]"]', 'https://github.com/test');
await page.fill('input[name="urls[Google Scholar]"]', '');
await page.fill('input[name="urls[Design Portfolio]"]', '');
await page.fill('textarea[name="comments"]', 'Test comment');

// Upload resume
await page.setInputFiles('input[type="file"][name="resume"]', '/app/SK_Resume.pdf');
console.log('Resume uploaded');

// Check all checkboxes
const checkboxes = await page.$$('input[type="checkbox"]');
console.log(`Found ${checkboxes.length} checkboxes`);
for (let i = 0; i < checkboxes.length; i++) {
    const cb = checkboxes[i];
    const isChecked = await cb.isChecked();
    if (!isChecked) {
        try {
            await cb.check();
            console.log(`Checked checkbox ${i}`);
        } catch (e) {
            console.log(`Failed to check checkbox ${i}: ${e.message}`);
        }
    }
}

// Fill radio buttons in survey
const radioGroups = await page.evaluate(() => {
    const groups = new Set();
    document.querySelectorAll('input[type="radio"]').forEach(r => groups.add(r.name));
    return [...groups];
});
console.log('Radio groups:', radioGroups);
for (const group of radioGroups) {
    const firstRadio = await page.$(`input[name="${group}"]:first-of-type`);
    if (firstRadio) {
        await firstRadio.check();
        console.log(`Selected radio in group: ${group}`);
    }
}

await page.waitForTimeout(2000);

// Scroll to bottom to ensure submit button is visible
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(2000);

// Take pre-submit screenshot
await page.screenshot({ path: '/app/output/debug2-pre-submit.png', fullPage: true });
console.log('Pre-submit screenshot saved');

// Find submit button
const submitBtn = await page.$('button[type="submit"]');
if (submitBtn) {
    console.log('Found button[type="submit"]');
    const isVisible = await submitBtn.isVisible();
    console.log('Is visible:', isVisible);

    // Click submit
    await submitBtn.click();
    console.log('Submit button clicked');

    // Wait for response
    await page.waitForTimeout(15000);

    // Check for errors
    const errors = await page.evaluate(() => {
        const errs = [];
        document.querySelectorAll('.error, [class*="error"], [class*="invalid"], .field-error, [class*="Error"]').forEach(el => {
            if (el.offsetParent !== null) errs.push(el.textContent.trim());
        });
        return errs;
    });
    console.log('Errors after submit:', errors);

    // Check page state
    const url = page.url();
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1500));
    console.log('URL:', url);
    console.log('Title:', title);
    console.log('Body:', bodyText);

    await page.screenshot({ path: '/app/output/debug2-post-submit.png', fullPage: true });
    console.log('Post-submit screenshot saved');
}

await browser.close();