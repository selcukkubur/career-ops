/**
 * batch-worker.js — Batch processing worker for Career-Ops Docker
 * 
 * Processes multiple job offers in parallel using OpenAI API.
 * Replaces the batch-runner.sh + claude -p workers.
 * 
 * Can be run:
 * 1. Via API: POST /api/batch
 * 2. Directly: node src/batch-worker.js --input batch/batch-input.tsv
 * 3. Via docker compose --profile batch
 * 
 * Features:
 * - Configurable parallelism
 * - State tracking for resumability
 * - Automatic retries
 * - Tracker TSV generation
 */

import { loadConfig } from './config.js';
import { evaluateOffer, generateTrackerTSV, saveTrackerTSV } from './agent.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import pino from 'pino';

const logger = pino({ name: 'batch-worker', level: process.env.LOG_LEVEL || 'info' });
const config = loadConfig();

// ============================================================
// CLI argument parsing
// ============================================================
const args = process.argv.slice(2);
const FLAGS = {
    input: null,
    parallel: 1,
    maxRetries: 2,
    startFrom: 0,
    retryFailed: false,
    dryRun: false,
};

for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '--input':
            FLAGS.input = args[++i];
            break;
        case '--parallel':
            FLAGS.parallel = parseInt(args[++i], 10);
            break;
        case '--max-retries':
            FLAGS.maxRetries = parseInt(args[++i], 10);
            break;
        case '--start-from':
            FLAGS.startFrom = parseInt(args[++i], 10);
            break;
        case '--retry-failed':
            FLAGS.retryFailed = true;
            break;
        case '--dry-run':
            FLAGS.dryRun = true;
            break;
        case '--help':
        case '-h':
            printUsage();
            process.exit(0);
    }
}

function printUsage() {
    console.log(`
Career-Ops Batch Worker — Process job offers in bulk

Usage: node src/batch-worker.js [OPTIONS]

Options:
  --input FILE        Input TSV file (default: batch/batch-input.tsv)
  --parallel N        Number of parallel workers (default: 1)
  --max-retries N     Max retry attempts per offer (default: 2)
  --start-from N      Start from offer ID N
  --retry-failed      Only retry failed offers
  --dry-run           Show what would be processed
  -h, --help          Show this help

Input TSV format:
  id\turl\tsource\tnotes
  1\thttps://example.com/job1\tscan\tAI Engineer role
`);
}

// ============================================================
// Input file parsing
// ============================================================
function parseBatchInput(filePath) {
    if (!existsSync(filePath)) {
        console.error(`ERROR: Input file not found: ${filePath}`);
        process.exit(1);
    }

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('id\t'));

    return lines.map(line => {
        const [id, url, source, notes] = line.split('\t');
        return {
            id: parseInt(id, 10),
            url: url?.trim(),
            source: source?.trim() || 'manual',
            notes: notes?.trim() || '',
        };
    }).filter(o => o.id && o.url);
}

// ============================================================
// State management
// ============================================================
function loadState(statePath) {
    if (!existsSync(statePath)) {
        return new Map();
    }

    const content = readFileSync(statePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('id\t'));
    const state = new Map();

    for (const line of lines) {
        const [id, url, status, started, completed, reportNum, score, error, retries] = line.split('\t');
        state.set(parseInt(id, 10), {
            id: parseInt(id, 10),
            url: url || '',
            status: status || 'pending',
            startedAt: started || '-',
            completedAt: completed || '-',
            reportNum: reportNum || '-',
            score: score || '-',
            error: error || '',
            retries: parseInt(retries, 10) || 0,
        });
    }

    return state;
}

function saveState(state, statePath) {
    const header = 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries';
    const lines = Array.from(state.values()).map(s =>
        `${s.id}\t${s.url}\t${s.status}\t${s.startedAt}\t${s.completedAt}\t${s.reportNum}\t${s.score}\t${s.error}\t${s.retries}`
    );

    writeFileSync(statePath, [header, ...lines].join('\n'));
}

// ============================================================
// Main batch processing
// ============================================================
async function runBatch() {
    const inputPath = FLAGS.input || join(config.paths.batch, 'batch-input.tsv');
    const statePath = join(config.paths.batch, 'batch-state.tsv');
    const logsDir = join(config.paths.batch, 'logs');

    mkdirSync(logsDir, { recursive: true });

    // Load input
    const offers = parseBatchInput(inputPath);
    if (offers.length === 0) {
        logger.info('No offers in input file');
        process.exit(0);
    }

    logger.info({ total: offers.length }, 'Loaded offers from input');

    // Load state
    const state = loadState(statePath);
    logger.info({ stateCount: state.size }, 'Loaded state');

    // Filter offers to process
    const pendingOffers = offers.filter(offer => {
        if (offer.id < FLAGS.startFrom) return false;

        const existingState = state.get(offer.id);

        if (FLAGS.retryFailed) {
            if (existingState?.status !== 'failed') return false;
            if (existingState.retries >= FLAGS.maxRetries) {
                logger.warn({ id: offer.id }, 'Skipping — max retries reached');
                return false;
            }
            return true;
        }

        if (existingState?.status === 'completed') return false;
        if (existingState?.status === 'failed' && existingState.retries >= FLAGS.maxRetries) {
            logger.warn({ id: offer.id }, 'Skipping — max retries reached');
            return false;
        }

        return true;
    });

    if (pendingOffers.length === 0) {
        logger.info('No offers to process');
        printSummary(state);
        process.exit(0);
    }

    logger.info({ count: pendingOffers.length }, 'Offers to process');

    if (FLAGS.dryRun) {
        console.log('\n=== DRY RUN ===');
        for (const offer of pendingOffers) {
            const existing = state.get(offer.id);
            console.log(`  #${offer.id}: ${offer.url} [${offer.source}] (status: ${existing?.status || 'new'})`);
        }
        process.exit(0);
    }

    // Process offers
    const results = [];
    let processed = 0;
    let failed = 0;

    // Process in batches of parallel
    const batchSize = Math.min(FLAGS.parallel, pendingOffers.length);

    for (let i = 0; i < pendingOffers.length; i += batchSize) {
        const batch = pendingOffers.slice(i, i + batchSize);

        // Process batch in parallel
        const promises = batch.map(async (offer) => {
            const existingState = state.get(offer.id) || {};
            const retries = existingState.retries || 0;
            const now = new Date().toISOString();

            // Update state to processing
            state.set(offer.id, {
                ...existingState,
                id: offer.id,
                url: offer.url,
                status: 'processing',
                startedAt: now,
                retries,
            });
            saveState(state, statePath);

            logger.info({ id: offer.id, url: offer.url, attempt: retries + 1 }, 'Processing offer...');

            try {
                const result = await evaluateOffer({
                    urlOrJD: offer.url,
                    config,
                    options: {
                        batchId: offer.id,
                        date: now.split('T')[0],
                    },
                });

                if (result.success) {
                    state.set(offer.id, {
                        id: offer.id,
                        url: offer.url,
                        status: 'completed',
                        startedAt: now,
                        completedAt: new Date().toISOString(),
                        reportNum: result.reportNum,
                        score: result.score,
                        error: '',
                        retries,
                    });

                    // Save tracker TSV
                    const tsvLine = generateTrackerTSV(
                        result.reportNum,
                        now.split('T')[0],
                        result.company,
                        result.role,
                        result.score,
                        'Evaluated',
                        offer.notes || `Batch evaluation via career-ops docker`
                    );
                    saveTrackerTSV(tsvLine, result.reportNum, result.company, config.paths);

                    logger.info({ id: offer.id, score: result.score }, 'Completed');
                    processed++;
                    return result;
                } else {
                    throw new Error(result.error || 'Unknown error');
                }
            } catch (err) {
                const newRetries = retries + 1;
                state.set(offer.id, {
                    id: offer.id,
                    url: offer.url,
                    status: 'failed',
                    startedAt: now,
                    completedAt: new Date().toISOString(),
                    reportNum: '-',
                    score: '-',
                    error: err.message.substring(0, 200),
                    retries: newRetries,
                });

                logger.error({ id: offer.id, error: err.message, attempt: newRetries }, 'Failed');
                failed++;

                // Write log
                writeFileSync(
                    join(logsDir, `failed-${offer.id}-${Date.now()}.log`),
                    `Offer #${offer.id}: ${offer.url}\nError: ${err.message}\nAttempt: ${newRetries}\nTimestamp: ${new Date().toISOString()}\n`
                );
            }
        });

        await Promise.all(promises);
        saveState(state, statePath);

        // Small delay between batches to avoid rate limiting
        if (i + batchSize < pendingOffers.length) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }

    // Print summary
    printSummary(state);

    // Merge tracker additions
    logger.info('Merging tracker additions...');
    try {
        const { execSync } = await import('child_process');
        execSync('node merge-tracker.mjs', {
            cwd: config.paths.projectRoot,
            stdio: 'inherit',
        });
    } catch (err) {
        logger.warn({ error: err.message }, 'Merge tracker failed');
    }
}

// ============================================================
// Summary
// ============================================================
function printSummary(state) {
    let total = 0, completed = 0, failed = 0, pending = 0;
    let scoreSum = 0, scoreCount = 0;

    for (const s of state.values()) {
        total++;
        switch (s.status) {
            case 'completed':
                completed++;
                if (s.score && s.score !== '-') {
                    scoreSum += parseFloat(s.score);
                    scoreCount++;
                }
                break;
            case 'failed':
                failed++;
                break;
            default:
                pending++;
        }
    }

    console.log('\n=== Batch Summary ===');
    console.log(`Total: ${total} | Completed: ${completed} | Failed: ${failed} | Pending: ${pending}`);
    if (scoreCount > 0) {
        console.log(`Average score: ${(scoreSum / scoreCount).toFixed(1)}/5 (${scoreCount} scored)`);
    }
}

// ============================================================
// Entry point
// ============================================================
runBatch().catch(err => {
    logger.error({ error: err.message }, 'Batch processing failed');
    process.exit(1);
});