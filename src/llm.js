/**
 * llm.js — OpenAI API wrapper for Career-Ops
 * 
 * Provides a unified interface for LLM calls with:
 * - Retry logic with exponential backoff
 * - Token counting for cost tracking
 * - Streaming support for long responses
 * - System prompt management
 */

import OpenAI from 'openai';
import pino from 'pino';

const logger = pino({ name: 'llm', level: process.env.LOG_LEVEL || 'info' });

/**
 * Create an OpenAI client
 */
function createClient(apiKey) {
    return new OpenAI({ apiKey });
}

/**
 * Make a chat completion request with retry logic
 */
export async function chatCompletion({ config, messages, options = {} }) {
    const client = createClient(config.openai.apiKey);

    const {
        maxRetries = 3,
        baseDelayMs = 1000,
        stream = false,
    } = options;

    const requestParams = {
        model: config.openai.model,
        messages,
        max_tokens: config.openai.maxTokens,
        temperature: config.openai.temperature,
        stream,
        ...options.extra,
    };

    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await client.chat.completions.create(requestParams);

            if (stream) {
                return response; // Return streaming response directly
            }

            const usage = response.usage;
            const content = response.choices[0]?.message?.content || '';

            logger.info({
                tokensUsed: usage?.total_tokens,
                promptTokens: usage?.prompt_tokens,
                completionTokens: usage?.completion_tokens,
                model: response.model,
                attempt: attempt + 1,
            }, 'LLM request completed');

            return {
                content,
                usage: {
                    promptTokens: usage?.prompt_tokens || 0,
                    completionTokens: usage?.completion_tokens || 0,
                    totalTokens: usage?.total_tokens || 0,
                },
                model: response.model,
                finishReason: response.choices[0]?.finish_reason,
            };
        } catch (err) {
            lastError = err;

            if (err.status === 429 || err.code === 'rate_limit_exceeded') {
                const delay = Math.min(baseDelayMs * Math.pow(2, attempt), 30000);
                logger.warn({ attempt: attempt + 1, delay }, 'Rate limited, retrying...');
                await sleep(delay);
                continue;
            }

            if (err.status >= 500) {
                const delay = Math.min(baseDelayMs * Math.pow(2, attempt), 30000);
                logger.warn({ attempt: attempt + 1, delay, error: err.message }, 'Server error, retrying...');
                await sleep(delay);
                continue;
            }

            // Non-retryable error
            throw err;
        }
    }

    throw new Error(`LLM request failed after ${maxRetries} retries: ${lastError.message}`);
}

/**
 * Make a structured JSON response request
 */
export async function jsonCompletion({ config, messages, schema, options = {} }) {
    const client = createClient(config.openai.apiKey);

    const requestParams = {
        model: config.openai.model,
        messages: [
            ...messages,
            { role: 'system', content: 'Respond in valid JSON format only. No markdown, no explanation.' }
        ],
        max_tokens: config.openai.maxTokens,
        temperature: config.openai.temperature,
        response_format: { type: 'json_object' },
        ...options.extra,
    };

    try {
        const response = await client.chat.completions.create(requestParams);
        const content = response.choices[0]?.message?.content || '{}';

        logger.info({
            tokensUsed: response.usage?.total_tokens,
            attempt: 1,
        }, 'JSON completion completed');

        return JSON.parse(content);
    } catch (err) {
        logger.error({ error: err.message }, 'JSON completion failed');
        throw new Error(`JSON completion failed: ${err.message}`);
    }
}

/**
 * Build system prompt from mode file with injected context
 */
export function buildSystemPrompt(modeContent, context = {}) {
    const {
        cv = '',
        articleDigest = '',
        profile = '',
        sharedContext = ''
    } = context;

    let systemPrompt = '';

    // Add shared context first
    if (sharedContext) {
        systemPrompt += `# Shared Context\n\n${sharedContext}\n\n---\n\n`;
    }

    // Add mode content
    systemPrompt += modeContent;

    // Add CV context
    if (cv) {
        systemPrompt += `\n\n---\n\n# Candidate CV (cv.md)\n\n\`\`\`markdown\n${cv}\n\`\`\``;
    }

    // Add article digest context
    if (articleDigest) {
        systemPrompt += `\n\n---\n\n# Article Digest (article-digest.md)\n\n\`\`\`markdown\n${articleDigest}\n\`\`\``;
    }

    // Add profile context
    if (profile) {
        systemPrompt += `\n\n---\n\n# Candidate Profile\n\n\`\`\`yaml\n${profile}\n\`\`\``;
    }

    return systemPrompt;
}

/**
 * Sleep utility for retry logic
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Estimate token count for a text (rough approximation)
 * ~4 chars per token for English
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Truncate messages to fit within context window
 */
export function truncateMessages(messages, maxTokens, reservedForResponse = 1000) {
    const maxAllowed = maxTokens - reservedForResponse;
    let totalTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);

    const truncated = [...messages];

    // Remove messages from the middle (older messages) if over limit
    while (totalTokens > maxAllowed && truncated.length > 2) {
        // Keep first (system) and last (user) messages
        const removeIndex = Math.floor(truncated.length / 2);
        const removed = truncated.splice(removeIndex, 1)[0];
        totalTokens -= estimateTokens(removed.content);
        logger.warn({ tokensRemoved: estimateTokens(removed.content) }, 'Truncated message to fit context window');
    }

    return truncated;
}

export default {
    chatCompletion,
    jsonCompletion,
    buildSystemPrompt,
    estimateTokens,
    truncateMessages,
};