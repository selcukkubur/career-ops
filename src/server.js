/**
 * server.js — Career-Ops API Server (Fastify)
 * 
 * REST API that exposes all career-ops functionality:
 * - POST /api/evaluate - Evaluate a job offer (URL or JD text)
 * - POST /api/scan - Scan portals for new jobs
 * - POST /api/pdf - Generate PDF CV
 * - POST /api/batch - Start batch processing
 * - GET /api/tracker - View application tracker
 * - GET /api/reports - List evaluation reports
 * - GET /api/health - Health check
 * 
 * Replaces the Claude Code interactive interface.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import pino from 'pino';
import { loadConfig } from './config.js';
import { evaluateOffer, generateTrackerTSV, saveTrackerTSV } from './agent.js';
import { scanPortals } from './scanner.js';
import { extractJD } from './extractor.js';
import { generatePDF, extractFormFields, generateAnswers, autoFillForm, generateLinkedInMessage, fullAutoApply } from './auto-apply.js';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const logger = pino({ name: 'server', level: process.env.LOG_LEVEL || 'info' });
const config = loadConfig();

const fastify = Fastify({
    logger: {
        level: config.app.logLevel,
        transport: config.app.nodeEnv === 'development' ? {
            target: 'pino-pretty',
            options: { colorize: true },
        } : undefined,
    },
});

// Register plugins
await fastify.register(cors, { origin: true });
await fastify.register(rateLimit, {
    max: config.app.rateLimitRpm,
    timeWindow: '1 minute',
});

// ============================================================
// Health Check
// ============================================================
fastify.get('/health', async (request, reply) => {
    return {
        status: 'ok',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        openai: {
            configured: !!config.openai.apiKey,
            model: config.openai.model,
        },
        playwright: {
            browsersPath: config.playwright.browsersPath,
        },
        paths: {
            data: config.paths.data,
            reports: config.paths.reports,
            output: config.paths.output,
        },
    };
});

// ============================================================
// Evaluate a job offer
// ============================================================
fastify.post('/api/evaluate', async (request, reply) => {
    const { urlOrJD, options = {} } = request.body;

    if (!urlOrJD) {
        return reply.code(400).send({
            success: false,
            error: 'urlOrJD is required (URL string or JD text)',
        });
    }

    try {
        const result = await evaluateOffer({
            urlOrJD,
            config,
            options: {
                ...options,
                date: options.date || new Date().toISOString().split('T')[0],
            },
        });

        if (!result.success) {
            return reply.code(500).send(result);
        }

        // Save tracker TSV
        const tsvLine = generateTrackerTSV(
            result.reportNum,
            new Date().toISOString().split('T')[0],
            result.company,
            result.role,
            result.score,
            'Evaluated',
            `AI evaluation via career-ops docker`
        );
        saveTrackerTSV(tsvLine, result.reportNum, result.company, config.paths);

        return reply.code(200).send(result);
    } catch (err) {
        fastify.log.error({ error: err.message }, 'Evaluation failed');
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Extract JD from URL
// ============================================================
fastify.post('/api/extract', async (request, reply) => {
    const { url } = request.body;

    if (!url) {
        return reply.code(400).send({
            success: false,
            error: 'url is required',
        });
    }

    try {
        const result = await extractJD(url);
        return reply.code(200).send(result);
    } catch (err) {
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Scan portals for new jobs
// ============================================================
fastify.post('/api/scan', async (request, reply) => {
    const { dryRun = false } = request.body || {};

    try {
        const results = await scanPortals(config, { dryRun });

        return reply.code(200).send({
            success: true,
            count: results.length,
            results,
        });
    } catch (err) {
        fastify.log.error({ error: err.message }, 'Scan failed');
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Generate PDF from HTML
// ============================================================
fastify.post('/api/pdf', async (request, reply) => {
    const { html, company = 'custom', date } = request.body;

    if (!html) {
        return reply.code(400).send({
            success: false,
            error: 'html content is required',
        });
    }

    try {
        const outputDate = date || new Date().toISOString().split('T')[0];
        const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const outputPath = join(config.paths.output, `cv-${slug}-${outputDate}.pdf`);
        const tempHtml = join(config.paths.output, `temp-${slug}-${outputDate}.html`);

        writeFileSync(tempHtml, html);

        execSync(`node generate-pdf.mjs "${tempHtml}" "${outputPath}"`, {
            cwd: config.paths.projectRoot,
            stdio: 'pipe',
            timeout: 60000,
        });

        // Clean up temp file
        try {
            const { unlinkSync } = await import('fs');
            unlinkSync(tempHtml);
        } catch { /* ignore */ }

        return reply.code(200).send({
            success: true,
            outputPath,
            url: `/api/pdf/${slug}-${outputDate}.pdf`,
        });
    } catch (err) {
        fastify.log.error({ error: err.message }, 'PDF generation failed');
        return reply.code(500).send({
            success: false,
            error: `PDF generation failed: ${err.message}`,
        });
    }
});

// ============================================================
// List/download generated PDFs
// ============================================================
fastify.get('/api/pdf/:filename', async (request, reply) => {
    const { filename } = request.params;
    const pdfPath = join(config.paths.output, filename);

    if (!existsSync(pdfPath)) {
        return reply.code(404).send({ error: 'PDF not found' });
    }

    return reply.type('application/pdf').send(readFileSync(pdfPath));
});

// ============================================================
// List evaluation reports
// ============================================================
fastify.get('/api/reports', async (request, reply) => {
    if (!existsSync(config.paths.reports)) {
        return reply.code(200).send({ reports: [] });
    }

    const files = readdirSync(config.paths.reports)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse();

    const reports = files.map(f => {
        const match = f.match(/^(\d+)-(.+)-(\d{4}-\d{2}-\d{2})\.md$/);
        return {
            filename: f,
            number: match ? parseInt(match[1], 10) : 0,
            company: match ? match[2] : f,
            date: match ? match[3] : 'unknown',
        };
    });

    return reply.code(200).send({ reports });
});

// ============================================================
// Get single report content
// ============================================================
fastify.get('/api/reports/:filename', async (request, reply) => {
    const { filename } = request.params;
    const reportPath = join(config.paths.reports, filename);

    if (!existsSync(reportPath)) {
        return reply.code(404).send({ error: 'Report not found' });
    }

    const content = readFileSync(reportPath, 'utf-8');
    return reply.code(200).send({ filename, content });
});

// ============================================================
// View application tracker
// ============================================================
fastify.get('/api/tracker', async (request, reply) => {
    const appsPath = join(config.paths.data, 'applications.md');
    const dataPath = join(config.paths.data, 'applications.md');

    const pathToRead = existsSync(dataPath) ? dataPath : appsPath;

    if (!existsSync(pathToRead)) {
        return reply.code(404).send({ error: 'Applications tracker not found' });
    }

    const content = readFileSync(pathToRead, 'utf-8');

    // Parse markdown table into JSON
    const lines = content.split('\n').filter(line => line.trim().startsWith('|'));
    const entries = [];

    for (let i = 0; i < lines.length; i++) {
        // Skip header and separator lines
        if (lines[i].includes('---') || lines[i].includes('#') || lines[i].includes('| # |')) continue;

        const cells = lines[i].split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length >= 8) {
            entries.push({
                num: parseInt(cells[0]) || 0,
                date: cells[1],
                company: cells[2],
                role: cells[3],
                score: cells[4],
                status: cells[5],
                pdf: cells[6],
                report: cells[7],
                notes: cells[8] || '',
            });
        }
    }

    return reply.code(200).send({
        total: entries.length,
        entries: entries.sort((a, b) => b.num - a.num),
    });
});

// ============================================================
// Batch processing
// ============================================================
fastify.post('/api/batch', async (request, reply) => {
    const { offers, parallel = 1 } = request.body;

    if (!offers || !Array.isArray(offers) || offers.length === 0) {
        return reply.code(400).send({
            success: false,
            error: 'offers array is required (array of { urlOrJD })',
        });
    }

    const results = [];
    const date = new Date().toISOString().split('T')[0];

    for (let i = 0; i < offers.length; i++) {
        const offer = offers[i];

        try {
            const result = await evaluateOffer({
                urlOrJD: offer.urlOrJD,
                config,
                options: {
                    reportNumber: offer.reportNumber || (i + 1),
                    date,
                    batchId: offer.batchId,
                },
            });

            results.push(result);

            // Rate limit between evaluations
            if (i < offers.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (err) {
            results.push({
                success: false,
                urlOrJD: offer.urlOrJD,
                error: err.message,
            });
        }
    }

    const successCount = results.filter(r => r.success).length;

    return reply.code(200).send({
        success: true,
        total: offers.length,
        succeeded: successCount,
        failed: offers.length - successCount,
        results,
    });
});

// ============================================================
// Pipeline integrity checks
// ============================================================
fastify.post('/api/integrity/:action', async (request, reply) => {
    const { action } = request.params;

    const actions = {
        verify: 'verify-pipeline.mjs',
        normalize: 'normalize-statuses.mjs',
        dedup: 'dedup-tracker.mjs',
        merge: 'merge-tracker.mjs',
        'sync-check': 'cv-sync-check.mjs',
    };

    const script = actions[action];
    if (!script) {
        return reply.code(400).send({
            error: `Unknown action. Valid actions: ${Object.keys(actions).join(', ')}`,
        });
    }

    try {
        const output = execSync(`node ${script}`, {
            cwd: config.paths.projectRoot,
            encoding: 'utf-8',
            timeout: 30000,
        });

        return reply.code(200).send({ success: true, output });
    } catch (err) {
        return reply.code(500).send({
            success: false,
            error: err.message,
            output: err.stdout || err.stderr || '',
        });
    }
});

// ============================================================
// Get configuration (non-sensitive)
// ============================================================
fastify.get('/api/config', async (request, reply) => {
    return reply.code(200).send({
        openai: {
            model: config.openai.model,
            maxTokens: config.openai.maxTokens,
        },
        paths: config.paths,
        batch: config.batch,
        profile: config.profile ? {
            targetRoles: config.profile.target_roles,
            headline: config.profile.narrative?.headline,
        } : null,
    });
});

// ============================================================
// Auto-Apply: Full E2E pipeline (evaluate + extract form + generate answers + fill)
// ============================================================
fastify.post('/api/auto-apply', async (request, reply) => {
    const { urlOrJD, autoFill = true } = request.body;

    if (!urlOrJD) {
        return reply.code(400).send({
            success: false,
            error: 'urlOrJD is required',
        });
    }

    try {
        const result = await fullAutoApply({
            urlOrJD,
            config,
            options: { autoFill },
        });

        if (!result.success) {
            return reply.code(500).send(result);
        }

        return reply.code(200).send(result);
    } catch (err) {
        fastify.log.error({ error: err.message }, 'Auto-apply failed');
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Extract form fields from application URL
// ============================================================
fastify.post('/api/extract-form', async (request, reply) => {
    const { url } = request.body;

    if (!url) {
        return reply.code(400).send({
            success: false,
            error: 'url is required',
        });
    }

    try {
        const result = await extractFormFields(url, config);
        return reply.code(200).send(result);
    } catch (err) {
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Generate answers for form fields
// ============================================================
fastify.post('/api/generate-answers', async (request, reply) => {
    const { formFields, reportContent, cvContent, companyName, role } = request.body;

    if (!formFields || !Array.isArray(formFields)) {
        return reply.code(400).send({
            success: false,
            error: 'formFields array is required',
        });
    }

    try {
        const result = await generateAnswers({
            formFields,
            reportContent: reportContent || '',
            cvContent: cvContent || '',
            config,
            companyName: companyName || '',
            role: role || '',
        });

        if (!result.success) {
            return reply.code(500).send(result);
        }

        return reply.code(200).send(result);
    } catch (err) {
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Auto-fill form with answers
// ============================================================
fastify.post('/api/auto-fill', async (request, reply) => {
    const { applicationUrl, answers } = request.body;

    if (!applicationUrl || !answers) {
        return reply.code(400).send({
            success: false,
            error: 'applicationUrl and answers are required',
        });
    }

    try {
        const result = await autoFillForm({
            applicationUrl,
            answers,
            config,
        });

        if (!result.success) {
            return reply.code(500).send(result);
        }

        return reply.code(200).send(result);
    } catch (err) {
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Generate PDF from HTML (using Playwright)
// ============================================================
fastify.post('/api/pdf/generate', async (request, reply) => {
    const { html, filename = 'cv.pdf' } = request.body;

    if (!html) {
        return reply.code(400).send({
            success: false,
            error: 'html content is required',
        });
    }

    try {
        const outputPath = join(config.paths.output, filename);
        const result = await generatePDF(html, outputPath, config);

        if (!result.success) {
            return reply.code(500).send(result);
        }

        return reply.code(200).send(result);
    } catch (err) {
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Generate LinkedIn outreach messages
// ============================================================
fastify.post('/api/linkedin/message', async (request, reply) => {
    const { companyName, role, reportContent, recipientName, recipientTitle } = request.body;

    if (!companyName || !role) {
        return reply.code(400).send({
            success: false,
            error: 'companyName and role are required',
        });
    }

    try {
        const result = await generateLinkedInMessage({
            companyName,
            role,
            reportContent: reportContent || '',
            recipientName: recipientName || '',
            recipientTitle: recipientTitle || '',
            config,
        });

        if (!result.success) {
            return reply.code(500).send(result);
        }

        return reply.code(200).send(result);
    } catch (err) {
        return reply.code(500).send({
            success: false,
            error: err.message,
        });
    }
});

// ============================================================
// Batch auto-apply
// ============================================================
fastify.post('/api/batch-apply', async (request, reply) => {
    const { jobs, autoFill = true } = request.body;

    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
        return reply.code(400).send({
            success: false,
            error: 'jobs array is required',
        });
    }

    const results = [];

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];

        try {
            const result = await fullAutoApply({
                urlOrJD: job.urlOrJD,
                config,
                options: { autoFill },
            });

            results.push(result);

            // Rate limit between applications
            if (i < jobs.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        } catch (err) {
            results.push({
                success: false,
                urlOrJD: job.urlOrJD,
                error: err.message,
            });
        }
    }

    const successCount = results.filter(r => r.success).length;

    return reply.code(200).send({
        success: true,
        total: jobs.length,
        succeeded: successCount,
        failed: jobs.length - successCount,
        results,
    });
});

// ============================================================
// Application status dashboard
// ============================================================
fastify.get('/api/applications', async (request, reply) => {
    const { status, sort = 'date', order = 'desc', page = 1, limit = 20 } = request.query;

    const appsPath = join(config.paths.data, 'applications.md');

    if (!existsSync(appsPath)) {
        return reply.code(404).send({ error: 'Applications tracker not found' });
    }

    const content = readFileSync(appsPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().startsWith('|'));
    const entries = [];

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('---') || lines[i].includes('#') || lines[i].includes('| # |')) continue;

        const cells = lines[i].split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length >= 8) {
            entries.push({
                num: parseInt(cells[0]) || 0,
                date: cells[1],
                company: cells[2],
                role: cells[3],
                score: cells[4],
                status: cells[5],
                pdf: cells[6],
                report: cells[7],
                notes: cells[8] || '',
            });
        }
    }

    // Filter by status
    let filtered = entries;
    if (status) {
        filtered = entries.filter(e => e.status.toLowerCase() === status.toLowerCase());
    }

    // Sort
    filtered.sort((a, b) => {
        let aVal = a[sort] || '';
        let bVal = b[sort] || '';
        if (sort === 'num') {
            aVal = parseInt(aVal) || 0;
            bVal = parseInt(bVal) || 0;
        }
        if (order === 'desc') {
            return aVal > bVal ? -1 : 1;
        }
        return aVal < bVal ? -1 : 1;
    });

    // Paginate
    const total = filtered.length;
    const totalPages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + parseInt(limit));

    return reply.code(200).send({
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages,
        entries: paginated,
    });
});

// ============================================================
// Catch-all for unknown routes
// ============================================================
fastify.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
        error: 'Not Found',
        availableEndpoints: [
            'GET /health',
            'POST /api/evaluate',
            'POST /api/extract',
            'POST /api/scan',
            'POST /api/pdf',
            'GET /api/pdf/:filename',
            'GET /api/reports',
            'GET /api/reports/:filename',
            'GET /api/tracker',
            'POST /api/batch',
            'POST /api/integrity/:action',
            'GET /api/config',
        ],
    });
});

// ============================================================
// Start server
// ============================================================
const start = async () => {
    try {
        await fastify.listen({ port: config.app.port, host: '0.0.0.0' });
        logger.info({ port: config.app.port }, 'Career-Ops API server started');
        logger.info('Available endpoints:');
        logger.info('  GET  /health                    - Health check');
        logger.info('  POST /api/evaluate              - Evaluate job offer');
        logger.info('  POST /api/extract               - Extract JD from URL');
        logger.info('  POST /api/scan                  - Scan portals');
        logger.info('  POST /api/pdf                   - Generate PDF');
        logger.info('  GET  /api/reports               - List reports');
        logger.info('  GET  /api/tracker               - View tracker');
        logger.info('  POST /api/batch                 - Batch evaluate');
        logger.info('  POST /api/integrity/:action     - Pipeline checks');
        logger.info('  GET  /api/config                - Get config');
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
