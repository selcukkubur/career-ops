/**
 * extractor.js — JD extraction service for Career-Ops
 * 
 * Extracts job descriptions from URLs using Playwright.
 * Multi-strategy extraction:
 * 1. Playwright (preferred) - handles SPAs like Lever, Ashby, Greenhouse
 * 2. WebFetch fallback - for static pages
 * 3. WebSearch fallback - for indexed content
 * 
 * Replaces the browser actions that Claude Code would normally handle.
 */

import { chromium } from 'playwright';
import pino from 'pino';

const logger = pino({ name: 'extractor', level: process.env.LOG_LEVEL || 'info' });

// Bright Data Web Unlocker proxy configuration with session for captcha solving
const BRIGHTDATA_SESSION_ID = `sid${Date.now()}`;

const brightDataProxy = process.env.BRIGHTDATA_HOST ? {
    server: `${process.env.BRIGHTDATA_HOST}:${process.env.BRIGHTDATA_PORT}`,
    username: `${process.env.BRIGHTDATA_USERNAME}-session-${BRIGHTDATA_SESSION_ID}`,
    password: process.env.BRIGHTDATA_PASSWORD,
} : null;

if (brightDataProxy) {
    logger.info({
        host: brightDataProxy.server,
        username: brightDataProxy.username.substring(0, 40) + '...'
    }, 'Bright Data Web Unlocker proxy configured');
}

/**
 * Extract JD content from a URL
 * @param {string} url - The job listing URL
 * @param {object} options - Configuration options
 * @returns {Promise<object>} Extracted JD data
 */
export async function extractJD(url, options = {}) {
    const {
        headless = true,
        timeout = 30000,
    } = options;

    logger.info({ url }, 'Extracting JD from URL...');

    let browser;
    try {
        // Skip proxy for Lever URLs - they work fine without it and proxy causes timeouts
        const useProxy = url.includes('lever.co') ? undefined : (brightDataProxy || undefined);
        browser = await chromium.launch({
            headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
            proxy: useProxy,
            ignoreDefaultArgs: ['--disable-extensions'],
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();

        // Set a reasonable timeout
        page.setDefaultTimeout(timeout);

        // Navigate to URL - use domcontentloaded for faster loading
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

        // Wait for content to render
        await page.waitForLoadState('domcontentloaded');

        // Handle Cloudflare/anti-bot challenges - wait longer for JS to execute
        await page.waitForTimeout(5000);

        // For Greenhouse specifically, wait for the content iframe or main content
        if (url.includes('greenhouse.io')) {
            try {
                // Wait for the main content area to appear
                await page.waitForSelector('#main, .content, [data-gh-job-id]', { timeout: 15000 });
            } catch (e) {
                logger.warn({ url }, 'Greenhouse content did not fully render, trying anyway');
            }
        }

        // Additional wait for dynamic content
        await page.waitForTimeout(3000);

        // Strategy 1: Try to extract structured content
        const jdContent = await extractContent(page, url);

        // If content is still insufficient, try waiting more and re-extracting
        if (!jdContent || jdContent.trim().length < 100) {
            logger.warn({ url }, 'Initial extraction insufficient, waiting more...');
            await page.waitForTimeout(5000);
            const retryContent = await extractContent(page, url);
            if (retryContent && retryContent.trim().length >= 100) {
                return {
                    success: true,
                    url,
                    title: await page.title(),
                    content: retryContent,
                };
            }
        }

        if (!jdContent || jdContent.trim().length < 100) {
            logger.warn({ url, contentLength: jdContent?.length }, 'Insufficient content extracted');
            return {
                success: false,
                url,
                error: 'Insufficient content extracted from the page',
            };
        }

        // Get page title for company/role inference
        const pageTitle = await page.title();

        await browser.close();

        return {
            success: true,
            url,
            title: pageTitle,
            content: jdContent,
        };
    } catch (err) {
        logger.error({ url, error: err.message }, 'Failed to extract JD');
        if (browser) {
            await browser.close().catch(() => { });
        }
        return {
            success: false,
            url,
            error: err.message,
        };
    }
}

/**
 * Extract meaningful content from the page
 * Handles different ATS platforms:
 * - Greenhouse
 * - Lever
 * - Ashby
 * - Workday
 * - Generic
 */
async function extractContent(page, url) {
    const content = await page.evaluate((pageUrl) => {
        // Detect ATS platform from URL
        function detectPlatform(url) {
            const lower = url.toLowerCase();
            if (lower.includes('greenhouse.io')) return 'greenhouse';
            if (lower.includes('lever.co')) return 'lever';
            if (lower.includes('ashbyhq.com')) return 'ashby';
            if (lower.includes('myworkdayjobs.com') || lower.includes('workday')) return 'workday';
            if (lower.includes('indeed.com')) return 'indeed';
            return 'generic';
        }

        const platform = detectPlatform(pageUrl);
        let mainContent = '';

        switch (platform) {
            case 'greenhouse':
                // Greenhouse has content in specific areas
                // Try multiple selectors in order of specificity
                const ghSelectors = [
                    '#main',
                    '.content',
                    '[data-gh-job-id]',
                    '.job-content',
                    'article',
                    'main',
                ];
                for (const sel of ghSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText.length > 200) {
                        mainContent = el.innerText;
                        break;
                    }
                }
                // If still empty, try to find any div with substantial text
                if (!mainContent) {
                    const allDivs = document.querySelectorAll('div');
                    for (const div of allDivs) {
                        if (div.innerText.length > 500 && div.innerText.length < 20000) {
                            mainContent = div.innerText;
                            break;
                        }
                    }
                }
                break;

            case 'lever':
                // Lever has content in various structures
                const leverSelectors = [
                    '.posting-content',
                    '.job-content',
                    '.posting-description',
                    '.content',
                    'main',
                    '[class*="posting"]',
                ];
                for (const sel of leverSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText.length > 200) {
                        mainContent = el.innerText;
                        break;
                    }
                }
                // Fallback: get body text but filter out cookie notices
                if (!mainContent) {
                    const bodyText = document.body.innerText;
                    // Remove cookie notice text
                    mainContent = bodyText.replace(/🍪|dismiss|Privacy Notice|Cookie Policy/gi, '').trim();
                }
                break;

            case 'ashby':
                // Ashby uses classes with "job-board" prefix
                const ashbyContent = document.querySelector('.job-board-content, [class*="content"], main');
                mainContent = ashbyContent?.innerText || '';
                break;

            case 'workday':
                // Workday has specific structures
                const workdayContent = document.querySelector('[data-automation-id="jobPostHeader"], #job-detail, .job-details');
                mainContent = workdayContent?.innerText || '';
                break;

            case 'indeed':
                // Indeed has job details in specific containers
                const indeedContent = document.querySelector('#jobDescriptionText, .jobsearch-JobDescription-container, [id*="jobDescriptionText"]');
                mainContent = indeedContent?.innerText || '';
                // Fallback: try to get all text from the job detail section
                if (!mainContent) {
                    const jobDetail = document.querySelector('#jobDetailPage, .jobsearch-ViewJobDetails');
                    mainContent = jobDetail?.innerText || '';
                }
                break;

            default:
                // Generic: try to find the main content area
                const possibleSelectors = [
                    'article',
                    'main',
                    '[role="main"]',
                    '.job-content',
                    '.job-details',
                    '.job-description',
                    '.posting-content',
                    '.container',
                    '#main',
                    '#content',
                ];

                for (const selector of possibleSelectors) {
                    const el = document.querySelector(selector);
                    if (el && el.innerText.length > 200) {
                        mainContent = el.innerText;
                        break;
                    }
                }

                // Fallback to body if nothing found
                if (!mainContent) {
                    mainContent = document.body?.innerText || '';
                }
        }

        return mainContent;
    }, url);

    return content;
}

/**
 * Verify if a job listing is still active
 * @param {string} url - The job listing URL
 * @returns {Promise<boolean>} Whether the listing is still active
 */
export async function verifyListingActive(url) {
    logger.info({ url }, 'Verifying if listing is still active...');

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        page.setDefaultTimeout(30000);

        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForLoadState('domcontentloaded');
        await page.sleep(2000);

        // Check for indicators the listing is still active
        const isActive = await page.evaluate(() => {
            // Look for job title + description (active listing indicators)
            const hasJobTitle = !!document.querySelector('h1, .job-title, [data-automation-id="jobTitle"]');
            const hasDescription = !!document.querySelector('[class*="description"], article, .job-details');
            const hasApplyButton = !!document.querySelector('button, a, input[type="submit"]')?.textContent?.toLowerCase().includes('apply');

            // Check for closed/expired indicators
            const hasClosedMessage = !![...document.querySelectorAll('*')]
                .some(el => el.textContent?.toLowerCase().includes('position no longer available') ||
                    el.textContent?.toLowerCase().includes('position has been filled') ||
                    el.textContent?.toLowerCase().includes('this job is no longer available'));

            return hasJobTitle && hasDescription && !hasClosedMessage;
        });

        await browser.close();
        return isActive;
    } catch (err) {
        logger.warn({ url, error: err.message }, 'Could not verify listing status');
        if (browser) {
            await browser.close().catch(() => { });
        }
        return false; // Assume inactive if we can't verify
    }
}

export default {
    extractJD,
    verifyListingActive,
};