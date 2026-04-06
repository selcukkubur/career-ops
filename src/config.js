/**
 * config.js — Configuration loader for Career-Ops Docker
 * 
 * Loads configuration from environment variables and YAML files.
 * Provides a single source of truth for all configuration.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

/**
 * Load and validate configuration
 */
export function loadConfig() {
    const config = {
        // OpenAI Configuration
        openai: {
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '8192', 10),
            temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
        },

        // Application Configuration
        app: {
            nodeEnv: process.env.NODE_ENV || 'production',
            port: parseInt(process.env.PORT || '3000', 10),
            logLevel: process.env.LOG_LEVEL || 'info',
            rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '60', 10),
        },

        // Path Configuration
        paths: {
            data: process.env.CAREER_OPS_DATA_DIR || join(PROJECT_ROOT, 'data'),
            reports: process.env.CAREER_OPS_REPORTS_DIR || join(PROJECT_ROOT, 'reports'),
            output: process.env.CAREER_OPS_OUTPUT_DIR || join(PROJECT_ROOT, 'output'),
            config: process.env.CAREER_OPS_CONFIG_DIR || join(PROJECT_ROOT, 'config'),
            modes: join(PROJECT_ROOT, 'modes'),
            templates: join(PROJECT_ROOT, 'templates'),
            fonts: join(PROJECT_ROOT, 'fonts'),
            batch: join(PROJECT_ROOT, 'batch'),
            projectRoot: PROJECT_ROOT,
        },

        // Playwright Configuration
        playwright: {
            headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
            browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright',
        },

        // Batch Processing Configuration
        batch: {
            parallel: parseInt(process.env.BATCH_PARALLEL || '1', 10),
            maxRetries: parseInt(process.env.BATCH_MAX_RETRIES || '2', 10),
        },
    };

    // Validate required configuration
    if (!config.openai.apiKey) {
        console.error('ERROR: OPENAI_API_KEY environment variable is required');
        console.error('Set it via .env file or environment variable');
        process.exit(1);
    }

    // Load YAML configurations
    config.profile = loadProfile(config.paths);
    config.portals = loadPortals(config.paths);
    config.states = loadStates(config.paths);

    return config;
}

/**
 * Load profile configuration
 */
function loadProfile(paths) {
    const profilePath = join(paths.config, 'profile.yml');
    const examplePath = join(paths.config, 'profile.example.yml');

    const pathToLoad = existsSync(profilePath) ? profilePath : examplePath;

    if (!existsSync(pathToLoad)) {
        console.warn('Warning: No profile.yml or profile.example.yml found');
        return null;
    }

    try {
        const content = readFileSync(pathToLoad, 'utf-8');
        return yaml.load(content);
    } catch (err) {
        console.warn(`Warning: Could not parse profile configuration: ${err.message}`);
        return null;
    }
}

/**
 * Load portals configuration
 */
function loadPortals(paths) {
    const portalsPath = join(PROJECT_ROOT, 'portals.yml');
    const examplePath = join(paths.templates, 'portals.example.yml');

    // Check if path is a file (not a directory)
    const pathToLoad = existsSync(portalsPath) && !statSync(portalsPath).isDirectory()
        ? portalsPath
        : (existsSync(examplePath) ? examplePath : null);

    if (!pathToLoad) {
        console.warn('Warning: No portals.yml or portals.example.yml found');
        return null;
    }

    try {
        const content = readFileSync(pathToLoad, 'utf-8');
        return yaml.load(content);
    } catch (err) {
        console.warn(`Warning: Could not parse portals configuration: ${err.message}`);
        return null;
    }
}

/**
 * Load canonical states configuration
 */
function loadStates(paths) {
    const statesPath = join(paths.templates, 'states.yml');

    if (!existsSync(statesPath)) {
        // Return default states
        return {
            states: ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP']
        };
    }

    try {
        const content = readFileSync(statesPath, 'utf-8');
        return yaml.load(content);
    } catch (err) {
        console.warn(`Warning: Could not parse states configuration: ${err.message}`);
        return null;
    }
}

/**
 * Load a mode file and return its content as a string
 */
export function loadMode(modeName, paths) {
    const modePath = join(paths.modes, `${modeName}.md`);

    if (!existsSync(modePath)) {
        return null;
    }

    try {
        return readFileSync(modePath, 'utf-8');
    } catch (err) {
        console.warn(`Warning: Could not load mode ${modeName}: ${err.message}`);
        return null;
    }
}

/**
 * Load CV content
 */
export function loadCV(paths) {
    const cvPath = join(paths.projectRoot, 'cv.md');

    if (!existsSync(cvPath)) {
        return null;
    }

    try {
        return readFileSync(cvPath, 'utf-8');
    } catch (err) {
        console.warn(`Warning: Could not load CV: ${err.message}`);
        return null;
    }
}

/**
 * Load article digest content
 */
export function loadArticleDigest(paths) {
    const digestPath = join(paths.projectRoot, 'article-digest.md');

    if (!existsSync(digestPath)) {
        return null;
    }

    try {
        return readFileSync(digestPath, 'utf-8');
    } catch (err) {
        return null;
    }
}