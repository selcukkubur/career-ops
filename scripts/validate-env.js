/**
 * Environment Validation Script
 * 
 * Validates that all required environment variables are set
 * before starting the Career-Ops application.
 * 
 * Usage: node scripts/validate-env.js
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Required environment variables
const REQUIRED_VARS = [
    'OPENAI_API_KEY',
];

// Optional environment variables with defaults
const OPTIONAL_VARS = {
    OPENAI_MODEL: 'gpt-4o',
    OPENAI_MAX_TOKENS: '8192',
    OPENAI_TEMPERATURE: '0.7',
    NODE_ENV: 'production',
    PORT: '3000',
    LOG_LEVEL: 'info',
    PLAYWRIGHT_HEADLESS: 'true',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    BATCH_PARALLEL: '1',
    BATCH_MAX_RETRIES: '2',
    RATE_LIMIT_RPM: '60',
    CAREER_OPS_DATA_DIR: '/app/data',
    CAREER_OPS_REPORTS_DIR: '/app/reports',
    CAREER_OPS_OUTPUT_DIR: '/app/output',
};

function validateEnv() {
    let hasErrors = false;
    const warnings = [];
    const errors = [];

    // Check if .env file exists
    const envPath = join(projectRoot, '.env');
    if (!existsSync(envPath)) {
        errors.push('.env file not found. Copy .env.example to .env and fill in your values.');
        hasErrors = true;
    } else {
        // Load .env file manually (in case dotenv isn't loaded yet)
        try {
            const envContent = readFileSync(envPath, 'utf-8');
            const envVars = {};
            envContent.split('\n').forEach(line => {
                line = line.trim();
                if (line && !line.startsWith('#')) {
                    const [key, ...valueParts] = line.split('=');
                    const value = valueParts.join('=').trim();
                    if (key && value) {
                        envVars[key.trim()] = value;
                    }
                }
            });

            // Check required variables
            for (const varName of REQUIRED_VARS) {
                const value = process.env[varName] || envVars[varName];
                if (!value) {
                    errors.push(`Missing required environment variable: ${varName}`);
                    hasErrors = true;
                } else if (value.includes('your-key-here') || value.includes('sk-proj-your')) {
                    errors.push(`${varName} appears to be a placeholder value. Please set a valid API key.`);
                    hasErrors = true;
                }
            }

            // Check optional variables and warn about defaults
            for (const [varName, defaultValue] of Object.entries(OPTIONAL_VARS)) {
                const value = process.env[varName] || envVars[varName];
                if (!value) {
                    warnings.push(`${varName} not set, using default: ${defaultValue}`);
                }
            }
        } catch (err) {
            errors.push(`Failed to read .env file: ${err.message}`);
            hasErrors = true;
        }
    }

    // Print results
    console.log('\n=== Career-Ops Environment Validation ===\n');

    if (warnings.length > 0) {
        console.log('⚠️  Warnings:');
        warnings.forEach(w => console.log(`   - ${w}`));
        console.log('');
    }

    if (errors.length > 0) {
        console.log('❌ Errors:');
        errors.forEach(e => console.log(`   - ${e}`));
        console.log('');
        console.log('To fix these, copy .env.example to .env and fill in your values:');
        console.log('   cp .env.example .env');
        console.log('   # Edit .env with your OpenAI API key and other settings\n');
        process.exit(1);
    }

    console.log('✅ Environment validation passed!\n');
}

validateEnv();