/**
 * scanner.js — Portal scanning service for Career-Ops
 * 
 * Scans job portals for new opportunities using:
 * 1. Greenhouse API (structured JSON)
 * 2. Playwright for company career pages
 * 3. Title filtering based on portals.yml configuration
 * 
 * Replaces the WebSearch and Playwright browser actions that Claude Code would handle.
 */

import { chromium } from 'playwright';
import pino from 'pino';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const logger = pino({ name: 'scanner', level: process.env.LOG_LEVEL || 'info' });

/**
 * Scan all configured portals for new job listings
 * @param {object} config - Application configuration
 * @param {object} options - Scan options
 * @returns {Promise<Array>} List of discovered job listings
 */
export async function scanPortals(config, options = {}) {
    const {
        dryRun = false,
        maxResultsPerQuery = 50,
    } = options;

    logger.info('Starting portal scan...');

    const portalsConfig = config.portals;
    if (!portalsConfig) {
        logger.warn('No portals configuration found');
        return [];
    }

    const results = [];

    // Scan tracked companies
    const companies = portalsConfig.tracked_companies || [];
    const enabledCompanies = companies.filter(c => c.enabled !== false);

    logger.info({ count: enabledCompanies.length }, 'Scanning tracked companies...');

    for (const company of enabledCompanies) {
        try {
            const companyResults = await scanCompany(company, config);
            results.push(...companyResults);
            logger.info({ company: company.name, found: companyResults.length }, 'Company scan complete');
        } catch (err) {
            logger.error({ company: company.name, error: err.message }, 'Failed to scan company');
        }
    }

    // Filter results by title keywords
    const filteredResults = filterByTitle(results, portalsConfig.title_filter);

    logger.info({
        total: results.length,
        filtered: filteredResults.length,
        unique: filterDuplicates(filteredResults).length,
    }, 'Portal scan complete');

    // Save scan history for dedup
    if (!dryRun) {
        saveScanHistory(filteredResults, config);
    }

    return filterDuplicates(filteredResults);
}

/**
 * Scan a single company's career page
 */
async function scanCompany(company, config) {
    const results = [];

    // Check if company has Greenhouse API
    if (company.api) {
        const apiResults = await scanGreenhouseAPI(company.api, company.name);
        results.push(...apiResults);
    }

    // Scan via Playwright
    if (company.careers_url && company.scan_method !== 'websearch') {
        const playwrightResults = await scanWithPlaywright(company.careers_url, company.name);
        results.push(...playwrightResults);
    }

    return results;
}

/**
 * Scan Greenhouse API
 */
async function scanGreenhouseAPI(apiUrl, companyName) {
    const results = [];

    try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
            logger.warn({ status: response.status, url: apiUrl }, 'Greenhouse API request failed');
            return results;
        }

        const data = await response.json();
        const jobs = data.jobs || [];

        for (const job of jobs) {
            results.push({
                company: companyName,
                title: job.title,
                url: job.absolute_url || job.hosted_job_url,
                location: job.location?.name || 'Unknown',
                department: job.departments?.[0]?.name || '',
                source: 'greenhouse_api',
                scannedAt: new Date().toISOString(),
            });
        }
    } catch (err) {
        logger.error({ company: companyName, error: err.message }, 'Failed to scan Greenhouse API');
    }

    return results;
}

/**
 * Scan company career page using Playwright
 */
async function scanWithPlaywright(careersUrl, companyName) {
    const results = [];
    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        page.setDefaultTimeout(30000);

        await page.goto(careersUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForLoadState('domcontentloaded');
        await page.sleep(3000);

        // Extract job listings from the page
        const jobs = await page.evaluate(() => {
            const listings = [];

            // Try multiple strategies to find job links
            const selectors = [
                'a[href*="jobs"]',
                'a[href*="careers"]',
                'a[href*="position"]',
                'a[href*="openings"]',
                '.job-link a',
                '.listing a',
                'table a',
                '[data-automation-id="jobTitle"] a',
            ];

            const seenUrls = new Set();

            for (const selector of selectors) {
                const links = document.querySelectorAll(selector);
                links.forEach(link => {
                    const href = link.getAttribute('href');
                    const title = link.textContent?.trim();

                    if (href && title && title.length > 5 && !seenUrls.has(href)) {
                        // Skip non-job links
                        if (title.toLowerCase().includes('benefits') ||
                            title.toLowerCase().includes('culture') ||
                            title.toLowerCase().includes('about') ||
                            title.toLowerCase().includes('diversity') ||
                            title.toLowerCase().includes('login') ||
                            title.toLowerCase().includes('sign in')) {
                            return;
                        }

                        seenUrls.add(href);
                        listings.push({
                            title,
                            url: href.startsWith('http') ? href : null,
                        });
                    }
                });

                // If we found results, stop trying other selectors
                if (listings.length > 0) break;
            }

            return listings;
        });

        for (const job of jobs) {
            const absoluteUrl = job.url || new URL(job.url || '', careersUrl).href;
            results.push({
                company: companyName,
                title: job.title,
                url: absoluteUrl,
                location: 'Unknown',
                department: '',
                source: 'playwright',
                scannedAt: new Date().toISOString(),
            });
        }

        await browser.close();
    } catch (err) {
        logger.error({ company: companyName, error: err.message }, 'Failed to scan with Playwright');
        if (browser) {
            await browser.close().catch(() => { });
        }
    }

    return results;
}

/**
 * Filter results by title keywords
 */
function filterByTitle(results, filterConfig) {
    if (!filterConfig) return results;

    const positive = (filterConfig.positive || []).map(k => k.toLowerCase());
    const negative = (filterConfig.negative || []).map(k => k.toLowerCase());

    return results.filter(job => {
        const title = job.title.toLowerCase();

        // Check for at least one positive keyword
        const hasPositive = positive.some(k => title.includes(k));

        // Check no negative keywords
        const hasNegative = negative.some(k => title.includes(k));

        return hasPositive && !hasNegative;
    });
}

/**
 * Filter duplicate listings
 */
function filterDuplicates(results) {
    const seen = new Map();

    for (const job of results) {
        const key = `${job.company}-${job.title.toLowerCase().trim()}`;
        if (!seen.has(key) || !seen.get(key).url) {
            seen.set(key, job);
        }
    }

    return Array.from(seen.values());
}

/**
 * Save scan history for dedup tracking
 */
function saveScanHistory(results, config) {
    const scanHistoryPath = join(config.paths.data, 'scan-history.tsv');
    const currentDate = new Date().toISOString().split('T')[0];

    // Read existing history
    let existingEntries = [];
    if (existsSync(scanHistoryPath)) {
        try {
            const content = readFileSync(scanHistoryPath, 'utf-8');
            existingEntries = content.split('\n').filter(line => line.trim() && !line.startsWith('#'));
        } catch {
            // File is empty or corrupted, start fresh
        }
    }

    // Add new entries
    const existingUrls = new Set(existingEntries.map(e => e.split('\t')[1]));

    const newEntries = results.filter(job => !existingUrls.has(job.url));

    if (newEntries.length > 0) {
        const lines = newEntries.map(job =>
            `${currentDate}\t${job.url}\t${job.company}\t${job.title}\t${job.source}`
        );

        const header = existingEntries.length === 0 ? `# Scan History\n# Date\tURL\tCompany\tTitle\tSource\n` : '';
        writeFileSync(scanHistoryPath, header + [...existingEntries, ...lines].join('\n'));

        logger.info({ newEntries: newEntries.length }, 'Saved scan history');
    }
}

/**
 * Load scan history and return set of seen URLs
 */
function loadSeenUrls(config) {
    const scanHistoryPath = join(config.paths.data, 'scan-history.tsv');
    const seenUrls = new Set();

    if (!existsSync(scanHistoryPath)) {
        return seenUrls;
    }

    try {
        const content = readFileSync(scanHistoryPath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'));

        for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                seenUrls.add(parts[1]);
            }
        }
    } catch {
        // Ignore errors
    }

    return seenUrls;
}

export default {
    scanPortals,
    scanCompany,
    filterByTitle,
    filterDuplicates,
    saveScanHistory,
    loadSeenUrls,
};