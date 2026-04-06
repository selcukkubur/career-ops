/**
 * agent.js — Career-Ops LLM Agent (OpenAI-powered, replaces Claude Code)
 * 
 * Parses mode files, builds prompts with context, and executes the full
 * career-ops evaluation pipeline using OpenAI API.
 * 
 * Supports all modes:
 * - auto-pipeline: Full evaluation + report + PDF + tracker
 * - oferta: Single offer evaluation
 * - ofertas: Compare multiple offers
 * - scan: Portal scanning
 * - pdf: PDF generation
 * - batch: Batch processing
 * - tracker: View application status
 * - apply: Fill application forms
 * - pipeline: Process pending URLs
 * - contacto: LinkedIn outreach message
 * - deep: Deep company research
 * - training: Evaluate a course/cert
 * - project: Evaluate a portfolio project
 */

import pino from 'pino';
import { loadConfig, loadMode, loadCV, loadArticleDigest } from './config.js';
import { chatCompletion, buildSystemPrompt } from './llm.js';
import { extractJD, verifyListingActive } from './extractor.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import yaml from 'js-yaml';

const logger = pino({ name: 'agent', level: process.env.LOG_LEVEL || 'info' });

/**
 * Main evaluation pipeline — replaces Claude Code's auto-pipeline mode
 */
export async function evaluateOffer({ urlOrJD, config, options = {} }) {
    const {
        reportNumber = null,
        date = new Date().toISOString().split('T')[0],
        batchId = null,
    } = options;

    logger.info({ urlOrJD: typeof urlOrJD === 'string' ? urlOrJD.substring(0, 50) : 'direct JD' }, 'Starting evaluation...');

    // Step 1: Extract JD (if URL)
    let jdContent = '';
    let extractedUrl = urlOrJD;

    if (isURL(urlOrJD)) {
        const extraction = await extractJD(urlOrJD);
        if (!extraction.success) {
            return {
                success: false,
                error: `Failed to extract JD from URL: ${extraction.error}`,
            };
        }
        jdContent = extraction.content;
        extractedUrl = urlOrJD;
    } else {
        jdContent = urlOrJD;
    }

    // Step 2: Load context files
    const sharedMode = loadMode('_shared', config.paths);
    const ofertaMode = loadMode('oferta', config.paths) || loadMode('auto-pipeline', config.paths);
    const cv = loadCV(config.paths);
    const articleDigest = loadArticleDigest(config.paths);
    const profileYaml = config.profile ? yaml.dump(config.profile) : '';

    // Step 3: Build system prompt
    const systemPrompt = buildSystemPrompt(`${sharedMode}\n\n---\n\n${ofertaMode}`, {
        cv: cv || '',
        articleDigest: articleDigest || '',
        profile: profileYaml || '',
    });

    // Step 4: Build user message
    const userMessage = `
Evaluate this job opportunity:

${extractedUrl !== jdContent ? `**URL**: ${extractedUrl}\n` : ''}
**Job Description**:
${jdContent}

${reportNumber ? `**Report Number**: ${reportNumber}\n` : ''}
**Date**: ${date}
${batchId ? `**Batch ID**: ${batchId}\n` : ''}

Execute the full A-F evaluation pipeline, generate the report, and output the complete evaluation in markdown format.
Include all required sections: role summary, CV match, level strategy, comp research, personalization plan, and interview prep.
Output ONLY the markdown report content, no extra text or explanations.
`.trim();

    // Step 5: Call LLM
    try {
        const response = await chatCompletion({
            config,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            options: { maxRetries: 3 },
        });

        const reportContent = response.content;

        // Step 6: Parse the report for key data
        const parsedData = parseReport(reportContent, extractedUrl);

        // Step 7: Save report
        const { reportPath, reportNum } = saveReport(reportContent, parsedData, config.paths, date, reportNumber);

        return {
            success: true,
            reportNum: reportNumber || reportNum,
            reportPath,
            reportContent,
            score: parsedData.score,
            company: parsedData.company,
            role: parsedData.role,
            archetype: parsedData.archetype,
            tokenUsage: response.usage,
        };
    } catch (err) {
        logger.error({ error: err.message }, 'Evaluation failed');
        return {
            success: false,
            error: err.message,
        };
    }
}

/**
 * Parse report content for key metadata
 */
function parseReport(content, url) {
    // Extract score (format: X.X/5 or "Score: X.X")
    const scoreMatch = content.match(/(?:Score|Score:?)\s*[:=]?\s*(\d+\.?\d*)\s*\/?\s*(\d)?/i);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

    // Extract company name (usually in the header)
    const companyMatch = content.match(/#\s*(?:Evaluation|Report|Analysis).*?[-–—]?\s*([A-Z][a-zA-Z\s&]+?)(?:\s*[-–—|]|$)/i) ||
        content.match(/\*\*Company\*\*[:\s]+([^\n]+)/i);
    const company = companyMatch ? companyMatch[1].trim() : extractCompanyFromURL(url);

    // Extract role
    const roleMatch = content.match(/\*\*Role\*\*[:\s]+([^\n]+)/i) ||
        content.match(/\*\*Position\*\*[:\s]+([^\n]+)/i);
    const role = roleMatch ? roleMatch[1].trim() : extractRoleFromContent(content);

    // Extract archetype
    const archetypeMatch = content.match(/\*\*Archetype\*\*[:\s]+([^\n]+)/i) ||
        content.match(/Archetype[:\s]+([^\n]+)/i);
    const archetype = archetypeMatch ? archetypeMatch[1].trim() : 'Unknown';

    return { score, company, role, archetype };
}

/**
 * Save report to reports directory
 */
function saveReport(content, parsedData, paths, date, reportNumber = null) {
    const reportsDir = paths.reports;
    mkdirSync(reportsDir, { recursive: true });

    // Calculate report number
    let num = reportNumber;
    if (!num) {
        num = getNextReportNumber(reportsDir);
    }

    const companySlug = slugify(parsedData.company || 'unknown-company');
    const fileName = `${String(num).padStart(3, '0')}-${companySlug}-${date}.md`;
    const reportPath = join(reportsDir, fileName);

    writeFileSync(reportPath, content);
    logger.info({ reportPath }, 'Report saved');

    return { reportPath, reportNum: num };
}

/**
 * Generate next report number by scanning existing reports
 */
function getNextReportNumber(reportsDir) {
    if (!existsSync(reportsDir)) return 1;

    const files = readdirSync(reportsDir).filter(f => f.endsWith('.md'));
    let maxNum = 0;

    for (const file of files) {
        const match = file.match(/^(\d+)-/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNum) maxNum = num;
        }
    }

    return maxNum + 1;
}

/**
 * Generate tracker TSV line for batch processing
 */
export function generateTrackerTSV(reportNum, date, company, role, score, status, notes) {
    const pdfEmoji = '✅';
    const report = `[${reportNum}](reports/${String(reportNum).padStart(3, '0')}-${slugify(company)}-${date}.md)`;
    return `${reportNum}\t${date}\t${company}\t${role}\t${status}\t${score}/5\t${pdfEmoji}\t${report}\t${notes}`;
}

/**
 * Save tracker TSV line to batch/tracker-additions
 */
export function saveTrackerTSV(tsvLine, reportNum, company, paths) {
    const trackerDir = join(paths.batch, 'tracker-additions');
    mkdirSync(trackerDir, { recursive: true });

    const fileName = `${reportNum}-${slugify(company)}.tsv`;
    const filePath = join(trackerDir, fileName);

    writeFileSync(filePath, tsvLine);
    logger.info({ filePath }, 'Tracker TSV saved');
}

/**
 * Generate PDF (calls existing generate-pdf.mjs)
 */
export async function generatePDF(htmlContent, outputPath, config) {
    const { execSync } = await import('child_process');
    const tempHtml = join(config.paths.output, 'temp-cv.html');

    writeFileSync(tempHtml, htmlContent);

    try {
        execSync(`node generate-pdf.mjs ${tempHtml} ${outputPath}`, {
            cwd: config.paths.projectRoot,
            stdio: 'inherit',
        });
        return { success: true, outputPath };
    } catch (err) {
        logger.error({ error: err.message }, 'PDF generation failed');
        return { success: false, error: err.message };
    }
}

/**
 * Classify a job into an archetype
 */
export async function classifyArchetype({ jdContent, config }) {
    const sharedMode = loadMode('_shared', config.paths);

    const systemPrompt = buildSystemPrompt(sharedMode || '');

    const response = await chatCompletion({
        config,
        messages: [
            { role: 'system', content: `${systemPrompt}\n\nRespond with ONLY the archetype name, nothing else.` },
            { role: 'user', content: `Classify this job into one of the archetypes:\n\n${jdContent.substring(0, 3000)}` },
        ],
        options: { maxRetries: 2 },
    });

    return response.content.trim();
}

/**
 * Utility: Check if string is URL
 */
function isURL(str) {
    try {
        new URL(str);
        return true;
    } catch {
        return false;
    }
}

/**
 * Utility: Slugify string
 */
function slugify(str) {
    return str?.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'unknown';
}

/**
 * Utility: Extract company from URL
 */
function extractCompanyFromURL(url) {
    try {
        const u = new URL(url);
        const parts = u.hostname.split('.');
        if (parts.length >= 2) {
            return parts[parts.length - 2];
        }
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Utility: Extract role from content
 */
function extractRoleFromContent(content) {
    const match = content.match(/(?:Senior|Staff|Principal|Lead|Junior)?\s*[A-Z][a-zA-Z\s\/]+(?:Engineer|Manager|Architect|Developer|Analyst|Lead|Director)/i);
    return match ? match[0].trim() : 'Unknown Role';
}

export default {
    evaluateOffer,
    generateTrackerTSV,
    saveTrackerTSV,
    generatePDF,
    classifyArchetype,
};