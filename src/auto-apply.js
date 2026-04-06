/**
 * auto-apply.js — Full E2E auto-application pipeline
 * 
 * Implements:
 * - PDF CV generation
 * - Form field extraction (Greenhouse, Lever, Ashby)
 * - Answer generation using OpenAI
 * - Auto-fill forms via Playwright
 * - LinkedIn message generation
 */

import { chromium } from 'playwright';
import pino from 'pino';
import { chatCompletion, buildSystemPrompt } from './llm.js';
import { loadMode, loadCV } from './config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

const logger = pino({ name: 'auto-apply', level: process.env.LOG_LEVEL || 'info' });

// Bright Data Web Unlocker proxy configuration with captcha solving
// Use a persistent session for captcha solving to work across page loads
const BRIGHTDATA_SESSION_ID = `sid${Date.now()}`;

function getBrightDataProxyConfig() {
    if (!process.env.BRIGHTDATA_HOST) return null;

    // Bright Data requires session persistence for captcha solving
    // Format: username-zone-session-sidXXXXX
    const username = `${process.env.BRIGHTDATA_USERNAME}-session-${BRIGHTDATA_SESSION_ID}`;

    return {
        server: `${process.env.BRIGHTDATA_HOST}:${process.env.BRIGHTDATA_PORT}`,
        username: username,
        password: process.env.BRIGHTDATA_PASSWORD,
    };
}

const brightDataProxy = getBrightDataProxyConfig();

if (brightDataProxy) {
    logger.info({
        host: brightDataProxy.server,
        username: brightDataProxy.username.substring(0, 40) + '...'
    }, 'Bright Data Web Unlocker proxy configured for auto-apply with captcha solving');
}

// ============================================================
// PDF Generation
// ============================================================

/**
 * Generate PDF from HTML content using Playwright's Chromium
 */
export async function generatePDF(htmlContent, outputPath, config) {
    logger.info({ outputPath }, 'Generating PDF...');

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();

        // Set content and wait for rendering
        await page.setContent(htmlContent, { waitUntil: 'networkidle' });

        // Generate PDF
        await page.pdf({
            path: outputPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '20mm',
                right: '20mm',
                bottom: '20mm',
                left: '20mm',
            },
        });

        await browser.close();

        logger.info({ outputPath, size: existsSync(outputPath) ? 'created' : 'failed' }, 'PDF generated');

        return {
            success: true,
            outputPath,
            url: `/api/pdf/${outputPath.split('/').pop()}`,
        };
    } catch (err) {
        logger.error({ error: err.message }, 'PDF generation failed');
        if (browser) await browser.close().catch(() => { });
        return {
            success: false,
            error: err.message,
        };
    }
}

// ============================================================
// Form Field Extraction
// ============================================================

/**
 * Extract form fields from an application page
 */
export async function extractFormFields(applicationUrl, config) {
    logger.info({ url: applicationUrl }, 'Extracting form fields...');

    let browser;
    try {
        // Skip proxy for Lever URLs - proxy causes timeouts
        // For captcha, we'll handle it separately
        const useProxy = applicationUrl.includes('lever.co') ? undefined : (brightDataProxy || undefined);
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
            proxy: useProxy,
            ignoreDefaultArgs: ['--disable-extensions'],
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(60000);

        await page.goto(applicationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(10000);

        // For Greenhouse, click "Start Application" button if present
        const isGreenhouse = applicationUrl.includes('greenhouse.io');
        if (isGreenhouse) {
            try {
                // Wait for page to fully load
                await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
                await page.waitForTimeout(5000);

                // Take debug screenshot
                const debugPath = join(config.paths.output, `debug-before-click-${Date.now()}.png`);
                await page.screenshot({ path: debugPath, fullPage: true });
                logger.info({ debugPath }, 'Debug screenshot taken before button click');

                // Look for various possible start buttons
                const selectors = [
                    'button:has-text("Start Application")',
                    'a:has-text("Start Application")',
                    'button:has-text("Apply Now")',
                    'a:has-text("Apply Now")',
                    'button:has-text("Apply")',
                    'a:has-text("Apply")',
                    '[data-automation-id="apply_button"]',
                    '.apply-button',
                    '#apply-button',
                ];

                let startButton = null;
                for (const selector of selectors) {
                    try {
                        startButton = await page.$(selector);
                        if (startButton) {
                            logger.info({ selector }, 'Found application start button');
                            break;
                        }
                    } catch (e) {
                        // Try next selector
                    }
                }

                if (startButton) {
                    logger.info('Clicking application start button...');
                    await startButton.click();
                    await page.waitForTimeout(15000); // Wait for form to load

                    // Take debug screenshot after click
                    const debugAfterPath = join(config.paths.output, `debug-after-click-${Date.now()}.png`);
                    await page.screenshot({ path: debugAfterPath, fullPage: true });
                    logger.info({ debugAfterPath }, 'Debug screenshot taken after button click');
                } else {
                    logger.info('No start button found - form may already be visible');
                    // Take screenshot to see what's on page
                    const debugNoButtonPath = join(config.paths.output, `debug-no-button-${Date.now()}.png`);
                    await page.screenshot({ path: debugNoButtonPath, fullPage: true });
                    logger.info({ debugNoButtonPath }, 'Debug screenshot - no button found');
                }
            } catch (e) {
                logger.warn({ error: e.message }, 'Could not click start button');
            }
        }

        // Debug: log page content length and title
        const pageTitle = await page.title();
        const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 500));
        const inputCount = await page.evaluate(() => document.querySelectorAll('input, textarea, select').length);
        logger.info({ pageTitle, pageContentPreview: pageContent.substring(0, 200), inputCount }, 'Page debug info');

        // Detect platform and extract fields
        const fields = await page.evaluate((url) => {
            function detectPlatform(url) {
                const lower = url.toLowerCase();
                if (lower.includes('greenhouse.io')) return 'greenhouse';
                if (lower.includes('lever.co')) return 'lever';
                if (lower.includes('ashbyhq.com')) return 'ashby';
                return 'generic';
            }

            const platform = detectPlatform(url);
            const fields = [];

            // Extract all form inputs
            const inputs = document.querySelectorAll('input, textarea, select');

            inputs.forEach((input, index) => {
                // Skip hidden fields and submit buttons
                if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') return;

                // Find the label
                let label = '';
                const labelId = input.getAttribute('aria-labelledby') || input.id;
                if (labelId) {
                    const labelEl = document.querySelector(`label[for="${labelId}"], label[for="${input.id}"]`);
                    if (labelEl) label = labelEl.textContent.trim();
                }

                // Fallback: find label by proximity
                if (!label) {
                    const parent = input.closest('div, p, li');
                    if (parent) {
                        const labelEl = parent.querySelector('label');
                        if (labelEl) label = labelEl.textContent.trim();
                    }
                }

                // Fallback: use placeholder or name
                if (!label) {
                    label = input.placeholder || input.name || `Field ${index + 1}`;
                }

                // Determine field type
                let fieldType = 'text';
                if (input.tagName === 'TEXTAREA') fieldType = 'textarea';
                else if (input.tagName === 'SELECT') fieldType = 'select';
                else if (input.type === 'email') fieldType = 'email';
                else if (input.type === 'tel') fieldType = 'phone';
                else if (input.type === 'number') fieldType = 'number';
                else if (input.type === 'checkbox') fieldType = 'checkbox';
                else if (input.type === 'radio') fieldType = 'radio';
                else if (input.type === 'file') fieldType = 'file';

                // Get options for select/radio
                let options = [];
                if (fieldType === 'select') {
                    options = Array.from(input.querySelectorAll('option'))
                        .filter(o => o.value)
                        .map(o => ({ value: o.value, label: o.textContent.trim() }));
                } else if (fieldType === 'radio') {
                    const name = input.name;
                    const radios = document.querySelectorAll(`input[name="${name}"]`);
                    options = Array.from(radios)
                        .map(r => ({ value: r.value, label: r.nextElementSibling?.textContent.trim() || r.value }));
                }

                fields.push({
                    name: input.name || input.id || `field_${index}`,
                    type: fieldType,
                    label: label,
                    required: input.required || input.getAttribute('aria-required') === 'true',
                    placeholder: input.placeholder || '',
                    options: options,
                    maxLength: input.maxLength || null,
                });
            });

            return fields;
        }, applicationUrl);

        await browser.close();

        logger.info({ fieldCount: fields.length }, 'Form fields extracted');

        return {
            success: true,
            fields,
            url: applicationUrl,
        };
    } catch (err) {
        logger.error({ error: err.message }, 'Form extraction failed');
        if (browser) await browser.close().catch(() => { });
        return {
            success: false,
            error: err.message,
            fields: [],
        };
    }
}

// ============================================================
// Answer Generation
// ============================================================

/**
 * Generate answers for form fields using OpenAI
 */
export async function generateAnswers({ formFields, reportContent, cvContent, config, companyName, role }) {
    logger.info({ fieldCount: formFields.length }, 'Generating answers...');

    const sharedMode = loadMode('_shared', config.paths);
    const cv = cvContent || loadCV(config.paths) || '';
    const profileYaml = config.profile ? yaml.dump(config.profile) : '';

    const systemPrompt = buildSystemPrompt(sharedMode || '', {
        cv,
        profile: profileYaml,
    });

    const fieldsDescription = formFields.map(f =>
        `- ${f.label || f.name} (${f.type}${f.required ? ', required' : ''})${f.options.length ? ', options: ' + f.options.map(o => o.label || o.value).join(', ') : ''}`
    ).join('\n');

    const userMessage = `
Generate personalized answers for this job application form.

**Company:** ${companyName || 'Unknown'}
**Role:** ${role || 'Unknown'}

${reportContent ? `**Evaluation Report:**\n${reportContent.substring(0, 5000)}\n` : ''}

**Form Fields to Fill:**
${fieldsDescription}

**Tone Rules:**
- "I'm choosing you" - confident, selective, specific
- 2-4 sentences per text answer
- No fluff like "I'm passionate about..." or "I would love the opportunity..."
- Reference specific things from the JD/company
- Use proof points from the CV

**For each field, provide:**
- Text/textarea: A personalized answer
- Select: The best option value from available choices
- Yes/No: true or false based on candidate profile
- Email/Phone: Use candidate info from CV
- Salary: Suggest a range based on market rates

Return ONLY a JSON object with field names as keys and answers as values.
No markdown, no explanation, just valid JSON.

Example format:
{
  "first_name": "John",
  "email": "john@example.com",
  "why_this_role": "Your focus on AI infrastructure maps directly to my experience building production ML systems...",
  "work_authorization": "yes",
  "salary_expectations": "$180,000 - $220,000"
}
`.trim();

    try {
        const response = await chatCompletion({
            config,
            messages: [
                { role: 'system', content: `${systemPrompt}\n\nRespond in valid JSON format only. No markdown, no explanation.` },
                { role: 'user', content: userMessage },
            ],
            options: { maxRetries: 2 },
        });

        // Parse the JSON response
        let answers;
        try {
            // Try to extract JSON from the response
            const jsonMatch = response.content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                answers = JSON.parse(jsonMatch[0]);
            } else {
                answers = JSON.parse(response.content);
            }
        } catch (parseErr) {
            logger.error({ error: parseErr.message }, 'Failed to parse answer JSON');
            return {
                success: false,
                error: `Failed to parse generated answers: ${parseErr.message}`,
                rawContent: response.content,
            };
        }

        // Map answers back to fields
        const fieldAnswers = formFields.map(field => ({
            name: field.name,
            label: field.label,
            type: field.type,
            value: answers[field.name] || answers[field.label] || '',
            required: field.required,
        }));

        logger.info({ answerCount: fieldAnswers.length }, 'Answers generated');

        return {
            success: true,
            answers: fieldAnswers,
            tokenUsage: response.usage,
        };
    } catch (err) {
        logger.error({ error: err.message }, 'Answer generation failed');
        return {
            success: false,
            error: err.message,
        };
    }
}

// ============================================================
// Auto-Fill Form
// ============================================================

/**
 * Auto-fill an application form with generated answers
 */
export async function autoFillForm({ applicationUrl, answers, config }) {
    logger.info({ url: applicationUrl, answerCount: answers.length }, 'Auto-filling form...');

    let browser;
    try {
        // Skip proxy for Lever URLs - proxy causes timeouts
        const useProxy = applicationUrl.includes('lever.co') ? undefined : (brightDataProxy || undefined);
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
            proxy: useProxy,
            ignoreDefaultArgs: ['--disable-extensions'],
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(60000);

        await page.goto(applicationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(10000);

        // Fill each field
        const results = [];
        for (const answer of answers) {
            try {
                // Try to find the field by name, id, or label
                let field = await page.$(`[name="${answer.name}"]`);
                if (!field) field = await page.$(`#${answer.name}`);
                if (!field) {
                    // Try to find by label text
                    const labelEl = await page.$(`label:text("${answer.label}")`);
                    if (labelEl) {
                        const forAttr = await labelEl.getAttribute('for');
                        if (forAttr) {
                            field = await page.$(`#${forAttr}`);
                        }
                    }
                }

                if (!field) {
                    results.push({ name: answer.name, status: 'not_found' });
                    continue;
                }

                // Fill based on type
                if (answer.type === 'select') {
                    await field.selectOption({ value: answer.value });
                } else if (answer.type === 'checkbox') {
                    if (answer.value === 'true' || answer.value === true) {
                        await field.check();
                    } else {
                        await field.uncheck();
                    }
                } else if (answer.type === 'radio') {
                    await page.check(`input[name="${answer.name}"][value="${answer.value}"]`);
                } else if (answer.type === 'file') {
                    // Handle file uploads - use SK_Resume.pdf if available
                    const resumePath = join(config.paths.projectRoot, 'SK_Resume.pdf');
                    if (existsSync(resumePath)) {
                        const fileInput = await page.$(`input[type="file"][name="${answer.name}"]`);
                        if (fileInput) {
                            await fileInput.setInputFiles(resumePath);
                            results.push({ name: answer.name, status: 'file_uploaded' });
                            continue;
                        }
                    }
                    results.push({ name: answer.name, status: 'skipped_file_upload' });
                    continue;
                } else {
                    // Text, textarea, email, phone, etc.
                    await field.fill(String(answer.value));
                }

                results.push({ name: answer.name, status: 'filled' });
            } catch (err) {
                logger.warn({ field: answer.name, error: err.message }, 'Failed to fill field');
                results.push({ name: answer.name, status: 'error', error: err.message });
            }
        }

        // Take screenshot before submission
        const screenshotPath = join(config.paths.output, `form-${Date.now()}.png`);
        mkdirSync(config.paths.output, { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // Auto-check any unchecked required checkboxes (consent, privacy, etc.)
        try {
            const checkboxes = await page.$$('input[type="checkbox"]');
            for (const cb of checkboxes) {
                const isChecked = await cb.isChecked();
                if (!isChecked) {
                    // Check if it's required or a consent checkbox
                    const isRequired = await cb.getAttribute('required') !== null;
                    const parentText = await cb.evaluate(el => {
                        const parent = el.closest('div, p, li, label');
                        return parent ? parent.textContent.trim().toLowerCase() : '';
                    });
                    // Auto-check consent/privacy/required checkboxes
                    if (isRequired || parentText.includes('consent') || parentText.includes('privacy') ||
                        parentText.includes('agree') || parentText.includes('terms') ||
                        parentText.includes('data') || parentText.includes('processing')) {
                        try {
                            await cb.check();
                            logger.info('Auto-checked required/consent checkbox');
                        } catch (e) {
                            // Skip if can't check
                        }
                    }
                }
            }
        } catch (e) {
            logger.warn({ error: e.message }, 'Failed to auto-check checkboxes');
        }

        // Auto-submit the form
        let submitted = false;
        let submissionError = null;
        try {
            // For Lever URLs without proxy, skip captcha and try direct submit
            const isLever = applicationUrl.includes('lever.co');

            if (!isLever) {
                // Wait for hCaptcha to be solved by Bright Data (only for non-Lever URLs)
                logger.info('Waiting for hCaptcha to be solved by Bright Data...');

                // Check if hCaptcha is present and wait for it to be solved
                const hasHCaptcha = await page.evaluate(() => {
                    return document.querySelector('iframe[src*="hcaptcha"]') !== null ||
                        document.querySelector('[data-hcaptcha-widget-id]') !== null ||
                        document.querySelector('.h-captcha') !== null;
                });

                if (hasHCaptcha) {
                    logger.info('hCaptcha detected, attempting to solve...');

                    // Check if 2CAPTCHA_API_KEY is available (2captcha.com supports hCaptcha)
                    const twoCaptchaKey = process.env.TWOCAPTCHA_API_KEY;

                    if (twoCaptchaKey) {
                        // Use 2captcha to solve hCaptcha
                        try {
                            logger.info('Using 2captcha to solve hCaptcha...');

                            // Get the site key from the page
                            const siteKey = await page.evaluate(() => {
                                const iframe = document.querySelector('iframe[src*="hcaptcha"]');
                                if (iframe) {
                                    const src = iframe.getAttribute('src') || '';
                                    const match = src.match(/sitekey=([^&]+)/);
                                    if (match) return match[1];
                                }
                                // Also check for data-sitekey attribute
                                const widget = document.querySelector('[data-sitekey]');
                                if (widget) return widget.getAttribute('data-sitekey');
                                return null;
                            });

                            if (siteKey) {
                                logger.info({ siteKey: siteKey.substring(0, 20) + '...' }, 'hCaptcha site key found');

                                // Use 2captcha API v2 (createTask)
                                const createTaskUrl = 'https://api.2captcha.com/createTask';
                                const taskPayload = {
                                    clientKey: twoCaptchaKey,
                                    task: {
                                        type: 'HCaptchaTaskProxyless',
                                        websiteURL: page.url(),
                                        websiteKey: siteKey
                                    }
                                };
                                logger.info('Submitting hCaptcha to 2captcha API v2...');

                                const createResp = await fetch(createTaskUrl, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(taskPayload)
                                });
                                const createData = await createResp.json();
                                logger.info({ errorId: createData.errorId, status: createData.status }, '2captcha createTask response');

                                if (createData.errorId === 0 && createData.taskId) {
                                    const taskId = createData.taskId;
                                    logger.info({ taskId }, '2captcha task created, waiting for result...');

                                    // Poll for result
                                    let captchaToken = null;
                                    for (let i = 0; i < 40; i++) {
                                        await page.waitForTimeout(5000);

                                        const getResultUrl = 'https://api.2captcha.com/getTaskResult';
                                        const resultResp = await fetch(getResultUrl, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ clientKey: twoCaptchaKey, taskId })
                                        });
                                        const resultData = await resultResp.json();

                                        if (resultData.errorId === 0 && resultData.status === 'ready' && resultData.solution) {
                                            captchaToken = resultData.solution.gRecaptchaResponse;
                                            break;
                                        } else if (resultData.status === 'processing') {
                                            continue;
                                        } else {
                                            logger.warn({ error: resultData.errorDescription }, '2captcha failed');
                                            break;
                                        }
                                    }

                                    if (captchaToken) {
                                        logger.info('hCaptcha solved via 2captcha!');
                                        // Inject the token into the page
                                        await page.evaluate((token) => {
                                            // Set token in hidden input
                                            let tokenInput = document.querySelector('input[name="h-captcha-response"]');
                                            if (!tokenInput) {
                                                tokenInput = document.createElement('input');
                                                tokenInput.type = 'hidden';
                                                tokenInput.name = 'h-captcha-response';
                                                document.querySelector('form')?.appendChild(tokenInput);
                                            }
                                            tokenInput.value = token;

                                            // Also set in textarea if exists
                                            let tokenTextarea = document.querySelector('textarea[name="h-captcha-response"]');
                                            if (tokenTextarea) {
                                                tokenTextarea.value = token;
                                            }

                                            // Trigger hCaptcha callback if exists
                                            if (window.hcaptcha && window.hcaptcha.render) {
                                                const event = new Event('change', { bubbles: true });
                                                tokenInput.dispatchEvent(event);
                                            }
                                        }, captchaToken);
                                    } else {
                                        logger.warn('2captcha did not return a token');
                                    }
                                } else {
                                    logger.warn({ error: submitData.request }, '2captcha submission failed');
                                }
                            } else {
                                logger.warn('Could not find hCaptcha site key');
                            }
                        } catch (e) {
                            logger.warn({ error: e.message }, '2captcha failed, proceeding anyway...');
                        }
                    } else {
                        logger.warn('hCaptcha detected but no TWOCAPTCHA_API_KEY configured');
                        logger.warn('Add TWOCAPTCHA_API_KEY to .env to enable automatic hCaptcha solving');
                        logger.warn('Get API key at: https://2captcha.com');
                    }
                } else {
                    logger.info('No hCaptcha detected');
                    await page.waitForTimeout(5000);
                }
            } else {
                logger.info('Lever URL detected, skipping captcha and trying direct submit');
                await page.waitForTimeout(3000);
            }

            // Wait for any validation to clear
            await page.waitForTimeout(2000);

            // Try common submit button selectors
            const submitSelectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Submit application")',
                'button:has-text("Submit Application")',
                'button:has-text("Submit your application")',
                'button:has-text("Submit")',
                'button:has-text("Apply")',
                'button:has-text("Apply Now")',
                '.btn-submit',
                '.submit-btn',
                '[data-automation-id="submitBtn"]',
                '[data-automation-id="submit_button"]',
            ];

            for (const selector of submitSelectors) {
                try {
                    const submitBtn = await page.$(selector);
                    if (submitBtn) {
                        // Scroll to bottom of page first
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await page.waitForTimeout(3000);

                        // Try to scroll submit button into view
                        try {
                            await submitBtn.scrollIntoViewIfNeeded({ timeout: 5000 });
                        } catch (e) {
                            // If scroll fails, try JS click anyway
                        }

                        // Set up response listener BEFORE clicking submit
                        let submitResponse = null;
                        const responsePromise = page.waitForResponse(
                            resp => resp.url().includes('apply') && resp.request().method() === 'POST',
                            { timeout: 30000 }
                        ).catch(() => null);

                        // Use JavaScript click to bypass visibility issues
                        await submitBtn.evaluate(el => el.click());
                        logger.info({ selector }, 'Found submit button, submitting via JS click...');

                        // Wait a bit for any captcha validation to happen
                        await page.waitForTimeout(5000);

                        // Check page state after click (wrap in try-catch as page may be navigating)
                        let afterClickUrl, afterClickTitle, afterClickBody;
                        try {
                            afterClickUrl = page.url();
                            afterClickTitle = await page.title();
                            afterClickBody = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => 'Page navigating...');
                            logger.info({ afterClickUrl, afterClickTitle, bodyPreview: (afterClickBody || '').substring(0, 200) }, 'Page state after submit click');
                        } catch (e) {
                            logger.warn({ error: e.message }, 'Could not get page state after click');
                        }

                        // Wait for the POST response
                        submitResponse = await responsePromise;

                        // Wait for page to settle
                        await page.waitForTimeout(10000);

                        // Check page state (wrap in try-catch)
                        let currentUrl, pageTitle, bodyText;
                        try {
                            currentUrl = page.url();
                            pageTitle = await page.title();
                            bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000)).catch(() => 'Page still loading...');
                            logger.info({ currentUrl, pageTitle, bodyPreview: (bodyText || '').substring(0, 200) }, 'Post-submission page');
                        } catch (e) {
                            logger.warn({ error: e.message }, 'Could not get post-submission page state');
                            bodyText = '';
                            currentUrl = '';
                        }

                        // Check response status
                        const responseStatus = submitResponse ? submitResponse.status() : null;
                        logger.info({ responseStatus, responseUrl: submitResponse?.url() }, 'Submit response');

                        // Check for success indicators
                        const hasSuccess = bodyText.toLowerCase().includes('thank') ||
                            bodyText.toLowerCase().includes('submitted') ||
                            bodyText.toLowerCase().includes('confirmation') ||
                            bodyText.toLowerCase().includes('application received') ||
                            bodyText.toLowerCase().includes('we\'ll be in touch') ||
                            currentUrl.includes('success') ||
                            currentUrl.includes('confirmation') ||
                            currentUrl.includes('thank');

                        // Check for error indicators
                        const hasServerError = responseStatus && (responseStatus >= 400);
                        const hasCaptchaError = bodyText.toLowerCase().includes('captcha') || bodyText.toLowerCase().includes('hcaptcha');
                        const hasCloudflareError = bodyText.toLowerCase().includes('cloudflare') || bodyText.toLowerCase().includes('checking your browser');
                        const hasVerifyError = bodyText.toLowerCase().includes('error verifying');
                        const hasDuplicateError = bodyText.toLowerCase().includes('already applied') || bodyText.toLowerCase().includes('duplicate');

                        if (hasServerError) {
                            submissionError = `Server error (HTTP ${responseStatus})`;
                            logger.error({ status: responseStatus }, 'Server error on submission');
                        } else if (hasCaptchaError) {
                            submissionError = 'hCaptcha verification failed';
                            logger.warn('hCaptcha blocking submission');
                        } else if (hasCloudflareError) {
                            submissionError = 'Cloudflare bot protection detected';
                            logger.warn('Cloudflare blocking submission');
                        } else if (hasVerifyError) {
                            submissionError = 'Application verification failed';
                            logger.warn('Application verification failed');
                        } else if (hasDuplicateError) {
                            submissionError = 'Already applied to this position';
                            logger.warn('Duplicate application detected');
                        } else if (hasSuccess) {
                            submitted = true;
                            logger.info('Form submitted successfully - confirmation page detected');
                        } else {
                            // Check for validation errors
                            const hasErrors = await page.evaluate(() => {
                                const errorSelectors = [
                                    '.error', '.error-message', '.field-error',
                                    '[class*="error"]', '[class*="invalid"]',
                                ];
                                for (const sel of errorSelectors) {
                                    const el = document.querySelector(sel);
                                    if (el && el.offsetParent !== null) return true;
                                }
                                return false;
                            });

                            if (hasErrors) {
                                submissionError = 'Validation errors on form';
                                // Check for specific error messages
                                const errorText = await page.evaluate(() => {
                                    const body = document.body.innerText;
                                    if (body.includes('error verifying')) return 'duplicate_application';
                                    if (body.includes('already applied')) return 'already_applied';
                                    if (body.includes('required')) return 'missing_required_fields';
                                    return 'validation_error';
                                });
                                logger.warn({ errorType: errorText }, 'Form has validation errors, cannot submit');
                            } else {
                                submitted = true;
                                logger.info('Submit button clicked (form still visible but no errors)');
                            }
                        }
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            // If no button found, try pressing Enter on last field
            if (!submitted && !submissionError) {
                const lastField = await page.$('input:last-of-type, textarea:last-of-type');
                if (lastField) {
                    await lastField.press('Enter');
                    await page.waitForTimeout(5000);
                    submitted = true;
                }
            }
        } catch (e) {
            submissionError = e.message;
            logger.warn({ error: e.message }, 'Could not auto-submit form');
        }

        // Take post-submission screenshot
        const postSubmitPath = join(config.paths.output, `submitted-${Date.now()}.png`);
        await page.screenshot({ path: postSubmitPath, fullPage: true });

        await browser.close();

        const filledCount = results.filter(r => r.status === 'filled' || r.status === 'file_uploaded').length;
        logger.info({ filledCount, total: results.length, submitted }, 'Form filling complete');

        return {
            success: true,
            filled: filledCount,
            total: results.length,
            submitted,
            submissionError: submissionError || null,
            results,
            screenshotPath,
            postSubmitPath,
            reviewUrl: applicationUrl,
        };
    } catch (err) {
        logger.error({ error: err.message }, 'Auto-fill failed');
        if (browser) await browser.close().catch(() => { });
        return {
            success: false,
            error: err.message,
        };
    }
}

// ============================================================
// LinkedIn Message Generation
// ============================================================

/**
 * Generate LinkedIn outreach messages
 */
export async function generateLinkedInMessage({ companyName, role, reportContent, recipientName, recipientTitle, config }) {
    logger.info({ company: companyName, recipient: recipientName }, 'Generating LinkedIn messages...');

    const cv = loadCV(config.paths) || '';
    const profileYaml = config.profile ? yaml.dump(config.profile) : '';

    const userMessage = `
Generate LinkedIn outreach messages for a job application.

**Target Company:** ${companyName}
**Target Role:** ${role}
**Recipient:** ${recipientName || 'Recruiter'}, ${recipientTitle || ''}

${reportContent ? `**Evaluation Report:**\n${reportContent.substring(0, 3000)}\n` : ''}

**Candidate CV:**
${cv.substring(0, 2000)}

**Tone:** "I'm choosing you" - confident, specific, not desperate

Generate two messages:

1. **Connection Request** (max 300 characters) - Brief, mention the role and why interested
2. **Follow-up Message** (after connection accepted) - Longer, reference specific company/role details

Return ONLY valid JSON:
{
  "connectionMessage": "...",
  "followupMessage": "..."
}
`.trim();

    try {
        const response = await chatCompletion({
            config,
            messages: [
                { role: 'system', content: 'Respond in valid JSON format only. No markdown, no explanation.' },
                { role: 'user', content: userMessage },
            ],
            options: { maxRetries: 2 },
        });

        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        const messages = JSON.parse(jsonMatch ? jsonMatch[0] : response.content);

        return {
            success: true,
            connectionMessage: messages.connectionMessage || '',
            followupMessage: messages.followupMessage || '',
        };
    } catch (err) {
        logger.error({ error: err.message }, 'LinkedIn message generation failed');
        return {
            success: false,
            error: err.message,
        };
    }
}

// ============================================================
// Full Auto-Apply Pipeline
// ============================================================

/**
 * Full E2E auto-apply: evaluate → extract form → generate answers → fill form
 */
export async function fullAutoApply({ urlOrJD, config, options = {} }) {
    const { autoFill = true } = options;

    logger.info({ urlOrJD: typeof urlOrJD === 'string' ? urlOrJD.substring(0, 50) : 'direct JD' }, 'Starting full auto-apply...');

    // Step 1: Import evaluateOffer dynamically to avoid circular dependency
    const { evaluateOffer } = await import('./agent.js');

    // Step 2: Evaluate the job
    const evaluation = await evaluateOffer({ urlOrJD, config, options });

    if (!evaluation.success) {
        return {
            success: false,
            error: `Evaluation failed: ${evaluation.error}`,
            step: 'evaluation',
        };
    }

    // Step 3: If URL, try to find and fill application form
    let formResult = null;
    let answerResult = null;

    if (typeof urlOrJD === 'string' && urlOrJD.startsWith('http') && autoFill) {
        // Try to find application URL (usually same domain with /apply)
        let appUrl = urlOrJD;
        if (urlOrJD.includes('greenhouse.io')) {
            appUrl = urlOrJD.replace('/jobs/', '/apply/').replace('/job/', '/apply/');
        } else if (urlOrJD.includes('lever.co')) {
            // Lever: append /apply to the job URL
            appUrl = urlOrJD + '/apply';
        } else if (urlOrJD.includes('ashbyhq.com')) {
            // Ashby: append /apply to the job URL
            appUrl = urlOrJD + '/apply';
        }

        // Extract form fields
        const formExtraction = await extractFormFields(appUrl, config);

        if (formExtraction.success && formExtraction.fields.length > 0) {
            // Generate answers
            answerResult = await generateAnswers({
                formFields: formExtraction.fields,
                reportContent: evaluation.reportContent,
                cvContent: loadCV(config.paths),
                config,
                companyName: evaluation.company,
                role: evaluation.role,
            });

            if (answerResult.success) {
                // Fill the form
                formResult = await autoFillForm({
                    applicationUrl: appUrl,
                    answers: answerResult.answers,
                    config,
                });
            }
        }
    }

    return {
        success: true,
        evaluation: {
            reportNum: evaluation.reportNum,
            score: evaluation.score,
            company: evaluation.company,
            role: evaluation.role,
            archetype: evaluation.archetype,
        },
        formFilled: formResult?.success || false,
        formResults: formResult,
        answers: answerResult?.answers || [],
        screenshotUrl: formResult?.screenshotPath ? `/api/output/${formResult.screenshotPath.split('/').pop()}` : null,
        reviewUrl: formResult?.reviewUrl || null,
    };
}

export default {
    generatePDF,
    extractFormFields,
    generateAnswers,
    autoFillForm,
    generateLinkedInMessage,
    fullAutoApply,
};