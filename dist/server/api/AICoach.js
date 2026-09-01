
/**
 * Proxy route for the AI Coach feature.
 *
 * The browser cannot talk to an LLM endpoint directly:
 * 1. Our helmet CSP is `default-src 'self'` with no `connect-src`, so any
 *    cross-origin fetch() from the page is blocked outright.
 * 2. Most LLM endpoints don't send CORS headers to browsers, and Anthropic
 *    additionally requires an opt-in header for direct browser access.
 *
 * So the client posts the already-built prompt to us (same origin), and we
 * forward it to whatever endpoint the user configured in the AI Coach panel.
 *
 * The user's API key only lives in this request. It is never written to disk,
 * never logged, and never echoed back in an error message.
 */

import fs from 'node:fs';
import path from 'node:path';

import { logEvents } from "../middleware/logEvents.js";


// Constants -------------------------------------------------------------


/**
 * The user's own coach persona, edited by hand outside the app.
 *
 * It lives at the project root rather than under `src/`, because `build.js` wipes and
 * recopies `dist/` on every build — a prompt kept in there would be a file you edit and
 * then silently lose. Read fresh on each request, so editing it takes effect on the next
 * panel open with no rebuild and no restart.
 */
const PERSONA_FILENAME = 'tsc.md';

/** A prompt this long is already unreasonable, and it rides along on every coach turn. */
const MAX_PERSONA_CHARS = 20_000;


/**
 * How long we'll wait on the upstream LLM before giving up, when the caller doesn't
 * say. Generous, because a reasoning model asked to analyze a position genuinely is
 * slow and nobody is sitting there timing the coach panel.
 *
 * The AI *opponent* is the opposite case — the user is staring at the board waiting
 * for it — so it sends its own, much shorter `timeoutMillis`. Blanket-waiting two
 * minutes for a move is the failure the panel used to report as "AI 走完这一步用了 120.0s".
 */
const DEFAULT_TIMEOUT_MILLIS = 120_000;

/** Bounds on the caller-supplied `timeoutMillis`. */
const MIN_TIMEOUT_MILLIS = 5_000;
const MAX_TIMEOUT_MILLIS = 120_000;

/** Refuse absurdly large prompts before we even open a socket. */
const MAX_PROMPT_CHARS = 400_000;

const OPENAI_PATH = '/v1/chat/completions';
const ANTHROPIC_PATH = '/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const VALID_PROTOCOLS = ['openai', 'anthropic'];

const VALID_ROLES = ['user', 'assistant'];

/** Accepted values for `reasoning_effort`. Anything else means "leave it off". */
const VALID_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/** Cap on conversation turns, so a runaway chat history can't be replayed forever. */
const MAX_MESSAGES = 40;

/**
 * The parameter shapes we're willing to send, from richest to plainest.
 *
 * There is no way to ask an OpenAI-compatible endpoint which parameters it accepts,
 * so we find out by trying. A 400 usually means "I don't like one of your optional
 * parameters", not "your prompt is bad", so we walk down this ladder:
 *
 * - `full`    — `max_tokens` + `temperature` + `reasoning_effort`. What almost every
 *               chat model and relay wants.
 * - `modern`  — `max_completion_tokens` + `reasoning_effort`, no `temperature`. The
 *               GPT-5 / o-series shape: they reject `max_tokens` outright and reject
 *               any `temperature` other than 1. **Crucially this keeps
 *               `reasoning_effort`**, which is the biggest latency knob there is —
 *               dropping it silently hands the request back to the provider's default
 *               (medium), and a "low effort" setting stops meaning anything.
 * - `bare`    — `max_completion_tokens` only. For relays that 400 on anything they
 *               don't recognise.
 */
const BODY_VARIANTS = ['full', 'modern', 'bare'];

/**
 * Which variant last worked, per endpoint+model.
 *
 * Without this, a GPT-5 endpoint pays for a rejected `full` request on *every single
 * move* before the one that works — two round trips per move forever. Remembering the
 * answer makes the steady state one round trip. Keyed on the things that decide the
 * answer, so switching model or endpoint re-probes on its own.
 * @type {Map<string, number>}
 */
const workingVariant = new Map();

/** Keeps {@link workingVariant} from growing without bound if someone cycles models. */
const MAX_REMEMBERED_ENDPOINTS = 64;


// URL building -------------------------------------------------------------


/**
 * Turns whatever the user pasted into the "request URL" field into a full endpoint URL.
 *
 * Relay providers are wildly inconsistent about what they call a "base url", so we
 * accept all of these and produce the same result:
 *   https://api.example.com
 *   https://api.example.com/
 *   https://api.example.com/v1
 *   https://api.example.com/v1/chat/completions
 * @param {string} baseUrl - The URL the user configured
 * @param {string} protocol - 'openai' | 'anthropic'
 * @returns {URL} The endpoint to POST to
 */
function buildEndpoint(baseUrl, protocol) {
	const trimmed = baseUrl.trim().replace(/\/+$/, ''); // Strip trailing slashes
	const url = new URL(trimmed); // Throws if it isn't a valid absolute URL

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('URL must use http or https.');
	}

	const wantedPath = protocol === 'anthropic' ? ANTHROPIC_PATH : OPENAI_PATH;
	const path = url.pathname.replace(/\/+$/, '');

	// Already a complete endpoint? Leave it alone.
	if (path.endsWith('/chat/completions') || path.endsWith('/messages')) return url;

	// Ends at the version segment? Just append the rest of the path.
	if (/\/v\d+$/.test(path)) {
		url.pathname = path + (protocol === 'anthropic' ? '/messages' : '/chat/completions');
		return url;
	}

	// Bare host (or host + some prefix). Append the whole versioned path.
	url.pathname = path + wantedPath;
	return url;
}


// Protocol adapters -------------------------------------------------------------


/**
 * Cleans up a conversation into a shape both protocols accept.
 *
 * Anthropic requires the turns to start with 'user' and strictly alternate, which is
 * stricter than the OpenAI format. Rather than have two code paths, we normalize to
 * the strict shape: unknown roles are dropped, empty content is dropped, a leading
 * assistant turn is dropped, and consecutive same-role turns are merged.
 * @param {any} value - Whatever arrived in `body.messages`
 * @returns {{ role: string, content: string }[]} Possibly empty
 */
function normalizeMessages(value) {
	if (!Array.isArray(value)) return [];

	/** @type {{ role: string, content: string }[]} */
	const out = [];
	for (const entry of value.slice(-MAX_MESSAGES)) {
		if (entry === null || typeof entry !== 'object') continue;
		if (!VALID_ROLES.includes(entry.role)) continue;
		if (typeof entry.content !== 'string' || entry.content === '') continue;

		if (out.length === 0 && entry.role === 'assistant') continue; // Can't open with the assistant

		const previous = out[out.length - 1];
		if (previous !== undefined && previous.role === entry.role) {
			previous.content += `\n\n${entry.content}`; // Merge, to keep the alternation intact
			continue;
		}
		out.push({ role: entry.role, content: entry.content });
	}

	// A trailing assistant turn would be us asking the model to continue its own
	// sentence, which is never what the caller meant.
	while (out.length > 0 && out[out.length - 1].role === 'assistant') out.pop();

	return out;
}

/**
 * Builds the headers and body for the configured protocol.
 *
 * `variant` picks one of {@link BODY_VARIANTS}. Anthropic only has two meaningful
 * shapes (with and without `temperature`), so `modern` and `bare` collapse to the
 * same thing there; the caller skips duplicate bodies rather than re-sending them.
 * @returns {{ headers: Record<string,string>, body: string }}
 */
function buildRequest({ protocol, apiKey, model, system, messages, temperature, maxTokens, reasoningEffort, variant = 'full' }) {
	if (protocol === 'anthropic') {
		/** @type {Record<string, any>} */
		const payload = { model, system, messages, max_tokens: maxTokens };
		// No effort knob here: Anthropic's extended thinking is off unless asked for.
		if (variant === 'full') payload.temperature = temperature;
		return {
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION,
			},
			body: JSON.stringify(payload),
		};
	}

	// OpenAI-compatible
	/** @type {Record<string, any>} */
	const payload = {
		model,
		messages: [
			{ role: 'system', content: system },
			...messages,
		],
	};
	if (variant === 'full') {
		payload.max_tokens = maxTokens;
		payload.temperature = temperature;
	} else {
		// Reasoning models count their hidden thinking against this, so it has to be
		// the larger `max_completion_tokens` field, and `temperature` must go.
		payload.max_completion_tokens = maxTokens;
	}
	// The single biggest latency lever on a reasoning model. Only `bare` gives it up.
	if (variant !== 'bare' && reasoningEffort !== '') payload.reasoning_effort = reasoningEffort;

	return {
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify(payload),
	};
}

/**
 * Digs the assistant's text out of a successful upstream response.
 * @param {string} protocol
 * @param {any} json - The parsed upstream response body
 * @returns {string | undefined}
 */
function extractText(protocol, json) {
	if (protocol === 'anthropic') {
		// { content: [ { type: 'text', text: '...' }, ... ] }
		if (!Array.isArray(json?.content)) return undefined;
		const text = json.content
			.filter(block => block?.type === 'text' && typeof block.text === 'string')
			.map(block => block.text)
			.join('');
		return text.length > 0 ? text : undefined;
	}

	// OpenAI-compatible: { choices: [ { message: { content: '...' } } ] }
	const content = json?.choices?.[0]?.message?.content;
	if (typeof content === 'string') return content;
	// A few relays return the content as an array of parts instead of a string.
	if (Array.isArray(content)) {
		const text = content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
		return text.length > 0 ? text : undefined;
	}
	return undefined;
}

/**
 * Pulls a human-readable message out of an upstream error body,
 * so the user can see "model not found" instead of just "400".
 * @param {any} json
 * @returns {string | undefined}
 */
function extractUpstreamError(json) {
	const candidates = [json?.error?.message, json?.error, json?.message, json?.detail];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.length > 0) return candidate.slice(0, 500);
	}
	return undefined;
}


// Sending -------------------------------------------------------------


/**
 * Does one POST to the upstream endpoint, with its own timeout, and reads the reply.
 *
 * Never throws: a transport failure comes back as `failure`, ready to hand straight
 * to the client. A non-2xx *response* is not a failure here — the caller decides
 * whether to retry it.
 * @param {URL} endpoint
 * @param {Record<string,string>} headers
 * @param {string} upstreamBody
 * @param {number} timeoutMillis - How long to wait before aborting this attempt
 * @returns {Promise<{ status?: number, ok?: boolean, rawText?: string, json?: any, failure?: { status: number, message: string, timedOut?: boolean } }>}
 */
async function sendUpstream(endpoint, headers, upstreamBody, timeoutMillis) {
	const controller = new AbortController();
	const timeoutID = setTimeout(() => controller.abort(), timeoutMillis);

	let upstream;
	try {
		upstream = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: upstreamBody,
			signal: controller.signal,
		});
	} catch (error) {
		const timedOut = error?.name === 'AbortError';
		// Log the host only. NEVER the key, and never the whole request.
		logEvents(`AI Coach request to host "${endpoint.host}" failed: ${timedOut ? `timed out after ${timeoutMillis}ms` : error?.message}`, 'errLog.txt', { print: true });
		return {
			failure: {
				status: 504,
				message: timedOut
					? `The AI endpoint did not respond within ${Math.round(timeoutMillis / 1000)}s.`
					: `Could not reach the AI endpoint (${endpoint.host}).`,
				// Lets the client tell "your endpoint is hanging" apart from "your endpoint
				// answered, but with something we couldn't use". Different fixes entirely.
				timedOut,
			},
		};
	} finally {
		clearTimeout(timeoutID);
	}

	const rawText = await upstream.text();
	let json;
	try {
		json = JSON.parse(rawText);
	} catch {
		json = undefined;
	}
	return { status: upstream.status, ok: upstream.ok, rawText, json };
}


// Route -------------------------------------------------------------


/**
 * POST /api/ai-coach
 *
 * Body: { protocol, baseUrl, apiKey, model, system, temperature, maxTokens, reasoningEffort,
 * timeoutMillis } plus EITHER `user` (a single prompt string) OR `messages` (a conversation,
 * `[{ role: 'user' | 'assistant', content }]`) for the chat box.
 * Responds with { text, upstreamMillis, upstreamAttempts } on success, or { message } on
 * failure — plus `timedOut: true` when the failure was specifically the endpoint not answering.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function postAICoach(req, res) {
	const body = req.body;
	if (body === undefined || typeof body !== 'object') {
		return res.status(400).json({ message: 'Request body must be JSON.' });
	}

	const protocol = typeof body.protocol === 'string' ? body.protocol : 'openai';
	if (!VALID_PROTOCOLS.includes(protocol)) {
		return res.status(400).json({ message: `Unknown protocol "${protocol}".` });
	}

	if (typeof body.baseUrl !== 'string' || body.baseUrl.trim() === '') {
		return res.status(400).json({ message: 'Missing API request URL.' });
	}
	if (typeof body.apiKey !== 'string' || body.apiKey.trim() === '') {
		return res.status(400).json({ message: 'Missing API key.' });
	}
	if (typeof body.model !== 'string' || body.model.trim() === '') {
		return res.status(400).json({ message: 'Missing model name.' });
	}

	// A lone `user` string is the common case; `messages` is for the chat box.
	const messages = body.messages !== undefined
		? normalizeMessages(body.messages)
		: (typeof body.user === 'string' && body.user !== '' ? [{ role: 'user', content: body.user }] : []);
	if (messages.length === 0) {
		return res.status(400).json({ message: 'Missing prompt.' });
	}

	const system = typeof body.system === 'string' ? body.system : '';
	const totalChars = messages.reduce((sum, message) => sum + message.content.length, system.length);
	if (totalChars > MAX_PROMPT_CHARS) {
		return res.status(413).json({ message: 'Prompt is too large.' });
	}

	// Clamp the tuning knobs so a bad config can't produce a nonsense upstream request.
	const temperature = Number.isFinite(body.temperature) ? Math.min(Math.max(body.temperature, 0), 2) : 0.2;
	const maxTokens = Number.isInteger(body.maxTokens) ? Math.min(Math.max(body.maxTokens, 256), 32000) : 2048;
	const reasoningEffort = VALID_REASONING_EFFORTS.includes(body.reasoningEffort) ? body.reasoningEffort : '';
	const timeoutMillis = Number.isFinite(body.timeoutMillis)
		? Math.min(Math.max(body.timeoutMillis, MIN_TIMEOUT_MILLIS), MAX_TIMEOUT_MILLIS)
		: DEFAULT_TIMEOUT_MILLIS;

	let endpoint;
	try {
		endpoint = buildEndpoint(body.baseUrl, protocol);
	} catch (error) {
		// The URL itself is user config, not a secret, but keep the reply short.
		return res.status(400).json({ message: `Invalid API request URL: ${error.message}` });
	}

	const requestArgs = {
		protocol,
		apiKey: body.apiKey.trim(),
		model: body.model.trim(),
		system,
		messages,
		temperature,
		maxTokens,
		reasoningEffort,
	};

	// Walk the parameter ladder, starting from whatever last worked for this
	// endpoint+model so the common case is a single round trip.
	const cacheKey = `${protocol}|${endpoint.host}${endpoint.pathname}|${requestArgs.model}`;
	const startIndex = workingVariant.get(cacheKey) ?? 0;

	/** @type {any} */
	let result;
	let lastBody;
	let upstreamAttempts = 0;
	let upstreamMillis = 0;

	// One deadline for the whole route, not one per rung. Otherwise a caller asking to
	// wait 30s could be kept waiting 90s while we probe three parameter shapes.
	const deadline = Date.now() + timeoutMillis;

	for (let index = startIndex; index < BODY_VARIANTS.length; index++) {
		const variant = BODY_VARIANTS[index];
		const built = buildRequest({ ...requestArgs, variant });
		if (built.body === lastBody) continue; // This variant is identical here; nothing to learn
		lastBody = built.body;

		const remaining = deadline - Date.now();
		if (remaining < MIN_TIMEOUT_MILLIS && upstreamAttempts > 0) break; // Not enough budget left to be worth trying

		const started = Date.now();
		result = await sendUpstream(endpoint, built.headers, built.body, Math.max(remaining, MIN_TIMEOUT_MILLIS));
		const elapsed = Date.now() - started;
		upstreamAttempts++;
		upstreamMillis += elapsed;

		if (result.failure !== undefined) {
			return res.status(result.failure.status).json({
				message: result.failure.message,
				...(result.failure.timedOut === true ? { timedOut: true } : {}),
			});
		}

		// Anything other than a 400 is a real answer — success, auth trouble, rate limit,
		// a bad model name. None of those get better by dropping parameters.
		if (result.status !== 400) {
			if (result.ok) workingVariant.set(cacheKey, index);
			break;
		}

		logEvents(`AI Coach upstream "${endpoint.host}" rejected the "${variant}" parameter set (400 in ${elapsed}ms); trying a plainer one.`, 'errLog.txt', { print: true });
	}

	// Every shape was refused, so it isn't our parameters. Forget the memo, in case a
	// previously-good variant is what put us at the wrong rung of the ladder.
	if (result.status === 400) workingVariant.delete(cacheKey);
	if (workingVariant.size > MAX_REMEMBERED_ENDPOINTS) workingVariant.clear();

	if (!result.ok) {
		const upstreamMessage = extractUpstreamError(result.json) ?? result.rawText.slice(0, 500);
		// Status code + host is enough to debug. The body may echo the model name but never the key.
		logEvents(`AI Coach upstream "${endpoint.host}" responded ${result.status}.`, 'errLog.txt', { print: true });
		return res.status(502).json({
			message: `AI endpoint returned ${result.status}: ${upstreamMessage || '(no details)'}`,
		});
	}

	const text = extractText(protocol, result.json);
	if (text === undefined) {
		return res.status(502).json({
			message: 'AI endpoint returned a response in an unexpected shape. Is the protocol setting correct?',
		});
	}

	// Timings go back to the client so the panel can show where a slow move went.
	// Not logged: a line per request would bury the log for no benefit.
	console.log(`AI Coach: ${endpoint.host} answered in ${upstreamMillis}ms (${upstreamAttempts} upstream request${upstreamAttempts === 1 ? '' : 's'}).`);
	res.status(200).json({ text, upstreamMillis, upstreamAttempts });
}


/**
 * GET /api/ai-coach/persona
 *
 * Hands the browser the contents of `tsc.md` — the coach persona the user writes by hand.
 * There is no user input here: the path is a fixed constant joined onto the project root,
 * so there is nothing to traverse with.
 *
 * A missing file is not an error. The coach is perfectly usable without a persona, so the
 * answer is an empty string and the client just carries on with its built-in prompt.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
function getAICoachPersona(req, res) {
	const file = path.join(process.cwd(), PERSONA_FILENAME);

	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			logEvents(`Could not read the AI Coach persona file "${PERSONA_FILENAME}": ${error?.message}`, 'errLog.txt', { print: true });
		}
		return res.status(200).json({ text: '', present: false });
	}

	const truncated = text.length > MAX_PERSONA_CHARS;
	if (truncated) text = text.slice(0, MAX_PERSONA_CHARS);

	res.status(200).json({ text, present: text.trim() !== '', truncated });
}


export {
	postAICoach,
	getAICoachPersona,
};
