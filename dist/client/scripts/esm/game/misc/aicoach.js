/**
 * AI Coach — the logic half of the feature.
 *
 * Turns the current position into something an LLM can reason about, then talks to
 * the model through our own server proxy. Three consumers live here:
 *
 * - the coach, which recommends a move for the human (`requestAdvice`)
 * - the opponent, which picks and plays its own move (`requestOpponentMove`)
 * - the chat box, which answers questions in prose (`askQuestion`)
 *
 * All three share one position description and one legality check, so they can't
 * drift apart. Nothing the model says is trusted: every move it names is run
 * through `legalmoves` before it reaches the board.
 *
 * This script never touches the DOM. `guiaicoach` owns the panel,
 * `aicoachhighlight` owns the board highlight, and both read from here.
 */
import typeutil, { rawTypes } from '../../chess/util/typeutil.js';
import boardutil from '../../chess/util/boardutil.js';
import coordutil from '../../chess/util/coordutil.js';
import moveutil from '../../chess/util/moveutil.js';
import organizedpieces from '../../chess/logic/organizedpieces.js';
import icnconverter from '../../chess/logic/icn/icnconverter.js';
import localstorage from '../../util/localstorage.js';
import timeutil from '../../util/timeutil.js';
// @ts-ignore
import legalmoves from '../../chess/logic/legalmoves.js';
// @ts-ignore
import specialdetect from '../../chess/logic/specialdetect.js';
// Constants -------------------------------------------------------------
const STORAGE_KEY = 'ai_coach_config';
/** Keep the config around for a year, not localstorage's 24-hour default. */
const CONFIG_EXPIRY_MILLIS = timeutil.getTotalMilliseconds({ years: 1 });
/** Where the coach's verdict on the player lives. Separate from the config on purpose. */
const PROFILE_STORAGE_KEY = 'ai_coach_player_profile';
/**
 * Five years, i.e. effectively forever.
 *
 * This is the answer to an interview the player already sat through, and nothing about
 * it goes stale on its own. An expiry short enough to matter would only mean being asked
 * the three questions again for no reason — which is the exact thing this record exists
 * to prevent. The re-assess button is the intended way to drop it.
 */
const PROFILE_EXPIRY_MILLIS = timeutil.getTotalMilliseconds({ years: 5 });
/** Outside this range a number is a parse accident, not a rating. */
const MIN_ELO = 100;
const MAX_ELO = 3200;
/** The summary is replayed inside every system prompt, so it has to stay small. */
const MAX_PROFILE_SUMMARY_CHARS = 300;
const DEFAULT_CONFIG = {
    protocol: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    moveModel: '',
    reasoningEffort: 'low',
    temperature: 0.2,
    maxTokens: 2048,
    autoAnalyze: false,
    autoCritique: true,
};
/**
 * Above this many pieces we stop sending the full board listing and fall back
 * to material counts, because the payload stops being worth its token cost.
 */
const MAX_PIECES_LISTED = 600;
/**
 * How many of the mover's pieces we compute full legal moves for.
 * `legalmoves.calculate` runs check resolution, which isn't free.
 */
const MAX_DETAILED_PIECES = 48;
/** How much of the game history to replay for the model. */
const MAX_HISTORY_MOVES = 40;
/**
 * The compact budgets, used only for the AI opponent's own move request. That path
 * is the one the user waits on, so it trades context for latency: fewer input
 * tokens means a faster first token and less to read. The coach and the chat box
 * still get the full description — nobody is timing those.
 */
const COMPACT_HISTORY_MOVES = 8;
const COMPACT_DETAILED_PIECES = 24;
/**
 * How far out we advertise a sliding piece's range, in steps, on the opponent path.
 *
 * On an unbounded board a rook's range is literally `[-Infinity, Infinity]`, and a
 * model handed that will happily send a piece to [4,40] — legal, almost always
 * terrible, and it reads to a human as the piece having wandered off the board.
 * Capping what we *offer* keeps its choices near the action and shortens the
 * payload. It costs nothing in legality: captures are still listed exactly in
 * `canCapture` no matter how far away they are, and a move past the cap is still
 * accepted if the model asks for one.
 */
const COMPACT_SLIDE_HORIZON = 10;
/**
 * How far outside the pieces' own bounding box a destination may sit before we
 * treat the move as a wander rather than a real idea. Two squares of slack lets a
 * piece step just past the edge of the crowd — a rook lifting to an open file
 * beside the pawns — without letting it disappear into the void.
 */
const WANDER_MARGIN = 2;
/**
 * How long the AI opponent will wait on its endpoint before giving up on a move.
 *
 * Deliberately far below the proxy's 120s ceiling. A move request that hasn't come
 * back in half a minute is not going to produce a good move — the endpoint is hung,
 * the model name is wrong, or the relay has queued us behind someone else — and
 * making the player stare at the board for two minutes before we admit that is the
 * worst possible way to find out. The coach and the chat box keep the long timeout;
 * nobody is waiting on those with a clock running.
 */
const MOVE_TIMEOUT_MILLIS = 30_000;
/**
 * How much longer than the upstream budget we let our own fetch run.
 *
 * Our proxy owns the real deadline, so this only exists to stop a wedged local
 * server (rather than a wedged endpoint) from hanging the turn forever.
 */
const PROXY_TIMEOUT_SLACK_MILLIS = 5_000;
/**
 * The point of the whole exact-move path: hand the model a finished list of legal
 * moves instead of the data to derive them from.
 *
 * LLMs are bad at `[x + n*dx, y + n*dy]` and good at picking an item out of a list.
 * Enumerating locally costs about a millisecond per piece and removes the arithmetic
 * from the model's job entirely, which cuts both the thinking it has to do and the
 * number of illegal answers we have to reject. Above this many moves the list stops
 * being worth its tokens and we fall back to the range description.
 */
const MAX_ENUMERATED_MOVES = 220;
/**
 * The slide horizon we retry enumeration with when the full list blew the cap. Short
 * enough to always fit, long enough to still contain every sensible move.
 */
const NARROW_SLIDE_HORIZON = 4;
/**
 * Largest board window we'll draw as a picture, per axis. A walled 8x8 is 10 rows
 * with its wall ring; anything much wider stops being readable and starts being
 * expensive, and the piece listing covers it instead.
 */
const MAX_GRID_SPAN = 20;
const VALID_PROTOCOLS = ['openai', 'anthropic'];
const VALID_REASONING_EFFORTS = ['', 'minimal', 'low', 'medium', 'high'];
/**
 * How many times we'll let the AI opponent retry after proposing an illegal move.
 * Kept low on purpose: the model already returns a ranked list of candidates that
 * we validate locally, so a whole extra round trip is the last resort, not the first.
 */
const MAX_MOVE_ATTEMPTS = 2;
/** How many ranked candidate moves we ask the opponent for in one reply. */
const MOVE_CANDIDATES_REQUESTED = 5;
/**
 * When we fall back to a random move, sliding pieces have infinitely many
 * destinations. Only consider this many steps along each direction.
 */
const RANDOM_SLIDE_REACH = 8;
/** Chat turns we keep and replay. Each turn also carries a position snapshot, so this adds up fast. */
const MAX_CHAT_HISTORY = 16;
/**
 * Promotion preference, strongest first. Used when the model promotes without
 * saying what to, or asks for a piece this variant doesn't allow.
 */
const PROMOTION_PREFERENCE = [
    rawTypes.AMAZON, rawTypes.QUEEN, rawTypes.CHANCELLOR,
    rawTypes.ARCHBISHOP, rawTypes.ROOK, rawTypes.BISHOP, rawTypes.KNIGHT,
];
// Config -------------------------------------------------------------
/** Cached so we don't re-parse localstorage on every keystroke. */
let config;
/**
 * Reads the saved config, filling in defaults for anything missing or malformed.
 * Never throws — a corrupt entry just yields defaults.
 */
function getConfig() {
    if (config !== undefined)
        return config;
    let saved;
    try {
        saved = localstorage.loadItem(STORAGE_KEY);
    }
    catch {
        saved = undefined;
    }
    const merged = { ...DEFAULT_CONFIG };
    if (saved !== undefined && saved !== null && typeof saved === 'object') {
        if (VALID_PROTOCOLS.includes(saved.protocol))
            merged.protocol = saved.protocol;
        if (typeof saved.baseUrl === 'string')
            merged.baseUrl = saved.baseUrl;
        if (typeof saved.apiKey === 'string')
            merged.apiKey = saved.apiKey;
        if (typeof saved.model === 'string')
            merged.model = saved.model;
        if (typeof saved.moveModel === 'string')
            merged.moveModel = saved.moveModel;
        if (VALID_REASONING_EFFORTS.includes(saved.reasoningEffort))
            merged.reasoningEffort = saved.reasoningEffort;
        if (Number.isFinite(saved.temperature))
            merged.temperature = Math.min(Math.max(saved.temperature, 0), 2);
        if (Number.isInteger(saved.maxTokens))
            merged.maxTokens = Math.min(Math.max(saved.maxTokens, 256), 32000);
        if (typeof saved.autoAnalyze === 'boolean')
            merged.autoAnalyze = saved.autoAnalyze;
        if (typeof saved.autoCritique === 'boolean')
            merged.autoCritique = saved.autoCritique;
    }
    config = merged;
    return config;
}
/** Merges the given fields into the saved config. */
function saveConfig(changes) {
    const merged = { ...getConfig(), ...changes };
    config = merged;
    localstorage.saveItem(STORAGE_KEY, merged, CONFIG_EXPIRY_MILLIS);
    return merged;
}
/** True when there's enough config to actually attempt a request. */
function isConfigured() {
    const c = getConfig();
    return c.baseUrl.trim() !== '' && c.apiKey.trim() !== '' && c.model.trim() !== '';
}
// The player's remembered level -------------------------------------------------------------
/** Cached like the config, since it gets replayed into every prompt. */
let playerProfile;
/** Tells "not read yet" apart from "read, and there is nothing saved". */
let profileLoaded = false;
/**
 * The level the coach settled on, or undefined if it has never assessed this player.
 *
 * Never throws. A corrupt or half-written entry reads as "no profile", which costs the
 * player one interview rather than breaking the panel.
 */
function getProfile() {
    if (profileLoaded)
        return playerProfile;
    profileLoaded = true;
    let saved;
    try {
        saved = localstorage.loadItem(PROFILE_STORAGE_KEY);
    }
    catch {
        saved = undefined;
    }
    if (saved === undefined || saved === null || typeof saved !== 'object')
        return undefined;
    const elo = Number(saved.elo);
    if (!Number.isFinite(elo) || elo < MIN_ELO || elo > MAX_ELO)
        return undefined;
    playerProfile = {
        elo: Math.round(elo),
        summary: typeof saved.summary === 'string' ? saved.summary.slice(0, MAX_PROFILE_SUMMARY_CHARS) : '',
        assessedAt: Number.isFinite(saved.assessedAt) ? Number(saved.assessedAt) : Date.now(),
    };
    return playerProfile;
}
/** Writes the assessment down. Returns what was actually stored, after clamping. */
function saveProfile(elo, summary) {
    const profile = {
        elo: Math.round(Math.min(Math.max(elo, MIN_ELO), MAX_ELO)),
        summary: summary.replace(/\s+/g, ' ').trim().slice(0, MAX_PROFILE_SUMMARY_CHARS),
        assessedAt: Date.now(),
    };
    playerProfile = profile;
    profileLoaded = true;
    localstorage.saveItem(PROFILE_STORAGE_KEY, profile, PROFILE_EXPIRY_MILLIS);
    return profile;
}
/**
 * Forgets the assessment, so the next session runs the three questions again.
 *
 * Deliberately NOT part of {@link clearChat}: wiping the conversation is something a
 * player does casually, and having to re-sit the interview every time would turn a
 * convenience into a punishment. The re-assess button is the only caller.
 */
function clearProfile() {
    playerProfile = undefined;
    profileLoaded = true;
    try {
        localstorage.deleteItem(PROFILE_STORAGE_KEY);
    }
    catch {
        // An unwritable store just means the old profile outlives this page load.
    }
}
/**
 * The tag we ask the coach to end its verdict with.
 *
 * A machine-readable tag rather than prose, because the number has to survive being
 * written by a persona in any language, and because "no tag, no write" is the thing
 * that keeps us from saving a number the coach never meant as a verdict.
 */
const ELO_TAG_REGEX = /<<\s*ELO\s*:?\s*(\d{3,4})\s*>>/i;
/**
 * The fallback, for a model that states the rating in prose and ignores the tag.
 *
 * Deliberately narrow, and only ever tried while no profile exists and the conversation
 * is still young — later on a four-digit number next to the word "rating" is far more
 * likely to be a remark about a famous game than a verdict on this player.
 */
const ELO_PROSE_REGEX = /(?:elo|等级分|积分|水平|rating)\D{0,12}(\d{3,4})/i;
/**
 * Watches a coach reply for the verdict, stores it, and returns the reply with the tag
 * taken back out.
 *
 * Run on every coach reply rather than only the one that follows the three questions,
 * because there is no reliable way to know which reply the coach decided to conclude on —
 * some personas ask a follow-up first. The explicit tag is what makes that safe.
 * @param allowProse - Whether the prose fallback may fire. False on the kickoff reply,
 * where the coach is *asking* about ratings and any number in it is an example, not an answer.
 * @returns The text to show the player and keep in the history
 */
function absorbAssessment(reply, allowProse = true) {
    const tagged = ELO_TAG_REGEX.exec(reply);
    if (tagged !== null) {
        const elo = Number(tagged[1]);
        // The prose around the tag is the coach's own summary of the player.
        if (Number.isFinite(elo) && elo >= MIN_ELO && elo <= MAX_ELO)
            saveProfile(elo, reply.replace(ELO_TAG_REGEX, ' '));
        // Stripped either way: a number we rejected is still not something to show.
        return reply.replace(ELO_TAG_REGEX, '').replace(/[ \t]+\n/g, '\n').trim();
    }
    if (allowProse && getProfile() === undefined && chatHistory.length <= 6) {
        const prose = ELO_PROSE_REGEX.exec(reply);
        if (prose !== null) {
            const elo = Number(prose[1]);
            if (Number.isFinite(elo) && elo >= MIN_ELO && elo <= MAX_ELO)
                saveProfile(elo, reply);
        }
    }
    return reply;
}
// Describing the position -------------------------------------------------------------
/** `Infinity` isn't valid JSON, so unbounded slide limits travel as strings. */
function serializeLimit(n) {
    if (n === Infinity)
        return 'inf';
    if (n === -Infinity)
        return '-inf';
    return n;
}
/** 'white' | 'black' | ... for a player number. */
function colorName(player) {
    return typeutil.strcolors[player] ?? `player${player}`;
}
/**
 * Whoever moves after the current mover. Variants can have more than two players,
 * so this walks the turn order rather than assuming white/black.
 */
function nextPlayer(gf) {
    const turnOrder = gf.gameRules.turnOrder;
    const index = turnOrder.indexOf(gf.whosTurn);
    if (index === -1)
        return gf.whosTurn;
    return turnOrder[(index + 1) % turnOrder.length];
}
/**
 * Rewrites a PlayerGroup (keyed by player number) into an object keyed by
 * color name, so the model sees `{ white: [...] }` instead of `{ "1": [...] }`.
 */
function namePlayerGroup(group) {
    if (group === undefined || group === null)
        return undefined;
    const out = {};
    for (const key of Object.keys(group)) {
        out[colorName(Number(key))] = group[key];
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * Walks every piece on the board once, grouping coordinates by color and piece name.
 *
 * `onlyColor` restricts the coordinate listing to one side. The opponent path uses
 * it to list just the enemy: the mover's own pieces already appear in `legalMoves`
 * with their coordinates, so listing them again is pure duplicated tokens.
 * @returns `{ listing, counts, total }` — `listing` is omitted when the board is too big.
 */
function collectPieces(gf, includeListing, onlyColor) {
    const listing = {};
    const counts = {};
    let total = 0;
    for (const [type, range] of gf.pieces.typeRanges) {
        const rawType = typeutil.getRawType(type);
        const color = colorName(typeutil.getColorFromType(type));
        const name = typeutil.getRawTypeStr(rawType);
        for (let idx = range.start; idx < range.end; idx++) {
            const piece = boardutil.getPieceFromIdx(gf.pieces, idx);
            if (!piece)
                continue; // Deleted pieces stay in the array so others keep their index
            total++;
            const colorCounts = counts[color] ??= {};
            colorCounts[name] = (colorCounts[name] ?? 0) + 1;
            if (!includeListing)
                continue;
            if (onlyColor !== undefined && color !== onlyColor)
                continue;
            const colorListing = listing[color] ??= {};
            (colorListing[name] ??= []).push(piece.coords);
        }
    }
    return { listing: includeListing ? listing : undefined, counts, total };
}
/**
 * Builds the per-piece legal move data for whoever is to move.
 *
 * We can't just list every legal move: a rook on an empty infinite board has
 * infinitely many. So each sliding direction is reported as a *step-count range*
 * along that direction's vector, which is both exact and compact. Captures are
 * always finite, so those we list outright.
 */
function collectLegalMoves(gf, maxPieces = MAX_DETAILED_PIECES, horizon) {
    const mover = gf.whosTurn;
    const pieces = [];
    let truncated = false;
    for (const rawType of Object.values(rawTypes)) {
        const type = typeutil.buildType(rawType, mover);
        const range = gf.pieces.typeRanges.get(type);
        if (!range)
            continue; // This game has no piece of this type
        for (let idx = range.start; idx < range.end; idx++) {
            if (pieces.length >= maxPieces) {
                truncated = true;
                break;
            }
            const piece = boardutil.getPieceFromIdx(gf.pieces, idx);
            if (!piece)
                continue;
            const moves = legalmoves.calculate(gf, piece);
            if (!legalmoves.hasAtleast1Move(moves))
                continue; // Nothing worth reporting
            const entry = {
                piece: typeutil.getRawTypeStr(rawType),
                at: piece.coords,
            };
            // Individual (jumping) moves are already a finite list of squares.
            const jumps = (moves.individual ?? []).map((c) => [c[0], c[1]]);
            if (jumps.length > 0)
                entry.jumpTo = jumps;
            // Sliding moves: 'dx,dy' -> [minSteps, maxSteps]
            const slides = {};
            const captures = [];
            for (const dirKey of Object.keys(moves.sliding ?? {})) {
                const limits = moves.sliding[dirKey];
                if (limits[0] === 0 && limits[1] === 0)
                    continue; // Fully blocked both ways
                // The advertised range may be narrowed; `limits` stays true, so the
                // capture scan below still finds captures beyond the horizon.
                const shown = horizon === undefined
                    ? limits
                    : [Math.max(limits[0], -horizon), Math.min(limits[1], horizon)];
                slides[dirKey] = [serializeLimit(shown[0]), serializeLimit(shown[1])];
                // A finite limit lands either just before a friendly piece or exactly
                // on an enemy one. Check the square to find out which.
                const dir = coordutil.getCoordsFromKey(dirKey);
                for (const steps of limits) {
                    const square = capturableSquare(gf, piece.coords, dir, steps, mover);
                    if (square !== undefined)
                        captures.push(square);
                }
            }
            if (Object.keys(slides).length > 0)
                entry.slideRanges = slides;
            // Any jump landing on an enemy is a capture too.
            for (const square of jumps) {
                const occupant = boardutil.getTypeFromCoords(gf.pieces, square);
                if (occupant === undefined)
                    continue;
                if (typeutil.getColorFromType(occupant) === mover)
                    continue;
                captures.push(square);
            }
            if (captures.length > 0)
                entry.canCapture = captures;
            pieces.push(entry);
        }
        if (pieces.length >= maxPieces) {
            truncated = true;
            break;
        }
    }
    return { pieces, truncated, maxPieces };
}
/** Returns the square `steps` along `dir` if an enemy piece is sitting there. */
function capturableSquare(gf, from, dir, steps, mover) {
    if (!Number.isFinite(steps) || steps === 0)
        return undefined;
    const square = [from[0] + steps * dir[0], from[1] + steps * dir[1]];
    const occupant = boardutil.getTypeFromCoords(gf.pieces, square);
    if (occupant === undefined)
        return undefined;
    if (typeutil.getColorFromType(occupant) === mover)
        return undefined;
    return square;
}
/** True for the neutral wall pieces that no piece may enter or slide through. */
function isWallType(type) {
    const raw = typeutil.getRawType(type);
    return raw === rawTypes.VOID || raw === rawTypes.OBSTACLE;
}
/**
 * Draws the position as a picture, the way every chess board in the model's training
 * data looks.
 *
 * This is the cheapest possible way to let an LLM "see" a position: one glance at a
 * grid tells it more than a hundred coordinate pairs do, and it costs fewer tokens
 * than the piece listing it replaces. Only usable when the pieces fit in a window we
 * can draw — on a board where everything is spread over thousands of squares there is
 * no picture to draw, and the listing has to serve instead.
 * @returns The rows top-to-bottom plus a legend, or undefined if the pieces don't fit a window
 */
function renderBoardMap(gf) {
    let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
    let walls = 0;
    // The window is sized on the *real* pieces. Wall rings are scenery: including them
    // in the measurement would let a distant decorative void blow the size limit.
    for (const [type, range] of gf.pieces.typeRanges) {
        const wall = isWallType(type);
        for (let idx = range.start; idx < range.end; idx++) {
            const piece = boardutil.getPieceFromIdx(gf.pieces, idx);
            if (!piece)
                continue;
            if (wall) {
                walls++;
                continue;
            }
            const [x, y] = piece.coords;
            if (x < left)
                left = x;
            if (x > right)
                right = x;
            if (y < bottom)
                bottom = y;
            if (y > top)
                top = y;
        }
    }
    if (left === Infinity)
        return undefined; // Nothing but scenery
    // One square of margin all round, so a wall ring is visible as a wall rather than
    // being cropped out of the picture entirely.
    left--;
    right++;
    bottom--;
    top++;
    if (right - left + 1 > MAX_GRID_SPAN || top - bottom + 1 > MAX_GRID_SPAN)
        return undefined;
    // Coordinates can be negative or two digits, so the column width follows the labels.
    const labels = [];
    for (let x = left; x <= right; x++)
        labels.push(String(x));
    let width = 2;
    for (const label of labels)
        width = Math.max(width, label.length);
    for (let y = bottom; y <= top; y++)
        width = Math.max(width, String(y).length);
    const cell = (text) => text.padStart(width, ' ');
    const rows = [`${cell('')}|${labels.map(cell).join(' ')}`];
    let walledWindow = false;
    for (let y = top; y >= bottom; y--) {
        const cells = [];
        for (let x = left; x <= right; x++) {
            const type = boardutil.getTypeFromCoords(gf.pieces, [x, y]);
            if (type === undefined) {
                cells.push(cell('.'));
                continue;
            }
            if (isWallType(type)) {
                walledWindow = true;
                cells.push(cell('##'));
                continue;
            }
            cells.push(cell(icnconverter.getAbbrFromType(type)));
        }
        rows.push(`${cell(String(y))}|${cells.join(' ')}`);
    }
    const legend = 'Rows run from the highest y at the top down to the lowest; the left column is y and the '
        + 'top row is x. UPPERCASE is white, lowercase is black (K/k king, Q/q queen, R/r rook, B/b bishop, '
        + 'N/n knight, P/p pawn). "." is an empty square. "##" is a wall square (a void or obstacle): no '
        + 'piece may stand on it or slide through it.';
    return { rows, legend, walled: walls > 0 && walledWindow };
}
/** Every destination we're prepared to name for one piece, with infinite slides clamped. */
function enumerateDestinations(from, legal, horizon) {
    const squares = [];
    let clamped = false;
    for (const coords of legal?.individual ?? []) {
        if (Array.isArray(coords) && coords.length >= 2)
            squares.push([Number(coords[0]), Number(coords[1])]);
    }
    const sliding = legal?.sliding;
    if (sliding !== undefined && sliding !== null) {
        for (const key of Object.keys(sliding)) {
            const limits = sliding[key];
            if (!Array.isArray(limits))
                continue;
            const dir = coordutil.getCoordsFromKey(key);
            let min = Number(limits[0]);
            let max = Number(limits[1]);
            if (min < -horizon) {
                min = -horizon;
                clamped = true;
            }
            if (max > horizon) {
                max = horizon;
                clamped = true;
            }
            for (let n = min; n <= max; n++) {
                if (n === 0)
                    continue;
                squares.push([from[0] + n * dir[0], from[1] + n * dir[1]]);
            }
        }
    }
    return { squares, clamped };
}
/**
 * Enumerates every legal move for whoever is to move, as plain strings.
 *
 * This is the whole point of the fast path. Instead of shipping the *data* to derive
 * moves from — direction vectors and step-count ranges, which an LLM gets wrong more
 * often than it gets right — we do the derivation here, in about a millisecond per
 * piece, and ship the answers. The model's job collapses from geometry to picking an
 * item out of a list, which is the thing it's actually good at.
 *
 * Every entry is run through the same `checkIfMoveLegal` the board itself uses, so the
 * list can't contain a move that would then be rejected when we try to play it.
 * @param horizon - Steps to clamp unbounded slides to. There's no edge to stop at otherwise.
 * @returns The list, or undefined if it's too long to be worth sending
 */
function enumerateLegalMoves(gf, horizon) {
    const mover = gf.whosTurn;
    const moves = [];
    const captures = [];
    const promotions = [];
    const seen = new Set();
    let exhaustive = true;
    for (const rawType of Object.values(rawTypes)) {
        const range = gf.pieces.typeRanges.get(typeutil.buildType(rawType, mover));
        if (!range)
            continue;
        for (let idx = range.start; idx < range.end; idx++) {
            const piece = boardutil.getPieceFromIdx(gf.pieces, idx);
            if (!piece)
                continue;
            const legal = legalmoves.calculate(gf, piece);
            if (!legalmoves.hasAtleast1Move(legal))
                continue;
            const { squares, clamped } = enumerateDestinations(piece.coords, legal, horizon);
            if (clamped)
                exhaustive = false;
            for (const to of squares) {
                const key = `${piece.coords[0]},${piece.coords[1]}>${to[0]},${to[1]}`;
                if (seen.has(key))
                    continue;
                // checkIfMoveLegal writes the special-move flags onto the coords, so it gets a copy.
                const coords = coordutil.copyCoords(to);
                if (!legalmoves.checkIfMoveLegal(gf, legal, piece.coords, coords, mover))
                    continue;
                seen.add(key);
                moves.push(key);
                if (moves.length > MAX_ENUMERATED_MOVES)
                    return undefined;
                const occupant = boardutil.getTypeFromCoords(gf.pieces, to);
                const takesSomething = (occupant !== undefined && typeutil.getColorFromType(occupant) !== mover)
                    || coords.enpassant !== undefined;
                if (takesSomething)
                    captures.push(key);
                if (coords.promoteTrigger)
                    promotions.push(key);
            }
        }
    }
    if (moves.length === 0)
        return undefined; // Stalemate/checkmate; let the range path report it
    return { moves, captures, promotions, exhaustive };
}
/**
 * Assembles everything the model needs to know about the current position.
 *
 * Two shapes come out of here. `compact` mode (the AI opponent's own move, the one
 * path a human sits and waits for) tries hard to produce the *fast* shape: a picture
 * of the board plus a finished list of every legal move. Everything else — and compact
 * mode on a board too big or too open to enumerate — gets the general shape, where
 * sliding moves are described as step-count ranges the model has to work out itself.
 *
 * Deliberately not using `gamecompressor.compressGamefile()` — it deep-copies
 * and console.logs the whole game, which we don't want to pay for on every
 * analysis. We read the same fields directly instead.
 */
function describePosition(gf, options = {}) {
    const compact = options.compact === true;
    const notes = [];
    const totalPieces = boardutil.getPieceCountOfGame(gf.pieces);
    const includeListing = totalPieces <= MAX_PIECES_LISTED;
    if (!includeListing)
        notes.push(`Board has ${totalPieces} pieces — too many to list individually, only material counts are given.`);
    // The fast shape, tried first on the latency-critical path. A wide-open midgame can
    // blow the size cap, so a shorter horizon gets one retry before we give up on it.
    const exact = compact
        ? (enumerateLegalMoves(gf, COMPACT_SLIDE_HORIZON) ?? enumerateLegalMoves(gf, NARROW_SLIDE_HORIZON))
        : undefined;
    const boardMap = exact !== undefined ? renderBoardMap(gf) : undefined;
    // With a board picture the mover's own pieces are visible, so nothing needs listing.
    // Without one, compact mode still lists the enemy: the mover's pieces show up in the
    // move list anyway, so listing them again is pure duplicated tokens.
    const onlyList = boardMap !== undefined
        ? undefined
        : (compact ? colorName(nextPlayer(gf)) : undefined);
    const { listing, counts } = collectPieces(gf, includeListing && boardMap === undefined, onlyList);
    let legalMoveData;
    if (exact !== undefined) {
        legalMoveData = exact.moves;
        if (!exact.exhaustive) {
            notes.push('legalMoves is complete except that sliding moves are only listed out to a few steps. '
                + 'Sliding further is legal but almost never good — the piece stops defending anything.');
        }
    }
    else {
        const ranges = collectLegalMoves(gf, compact ? COMPACT_DETAILED_PIECES : MAX_DETAILED_PIECES, compact ? COMPACT_SLIDE_HORIZON : undefined);
        legalMoveData = ranges.pieces;
        if (ranges.truncated)
            notes.push(`Legal moves listed for only the first ${ranges.maxPieces} pieces.`);
        if (compact) {
            notes.push(`slideRanges are capped at ${COMPACT_SLIDE_HORIZON} steps in each direction. Sliding further is legal `
                + 'but is almost never good — it abandons your position. Captures are listed in full under canCapture '
                + 'however far away they are.');
        }
    }
    const turnOrder = gf.gameRules.turnOrder;
    const halfMovesPlayed = gf.moves.length;
    const fullMove = (gf.startSnapshot?.fullMove ?? 1) + Math.floor(halfMovesPlayed / turnOrder.length);
    // Full move history, most compact form: '8,7>8,8=Q'
    const allMoves = gf.moves.map((m) => m.compact);
    const history = allMoves.slice(compact ? -COMPACT_HISTORY_MOVES : -MAX_HISTORY_MOVES);
    if (history.length < allMoves.length)
        notes.push(`Only the last ${history.length} of ${allMoves.length} moves are shown.`);
    const inCheck = gf.state.local.inCheck;
    const desc = {
        variant: gf.metadata?.Variant ?? 'Unknown',
        toMove: colorName(gf.whosTurn),
        fullMove,
        halfMovesPlayed,
        inCheck: Array.isArray(inCheck) ? inCheck : false,
        /** Tells the reader — model included — which of the two shapes this is. */
        moveFormat: exact !== undefined ? 'list' : 'ranges',
        // Kept even when there's a board picture: models are unreliable at counting
        // pieces off a grid, and this is the number an evaluation hangs on.
        materialCount: counts,
        legalMoves: legalMoveData,
        moveHistory: history,
    };
    if (exact !== undefined) {
        if (exact.captures.length > 0)
            desc['capturingMoves'] = exact.captures;
        if (exact.promotions.length > 0)
            desc['promotingMoves'] = exact.promotions;
    }
    if (boardMap !== undefined) {
        desc['board'] = boardMap.rows;
        desc['boardLegend'] = boardMap.legend;
        desc['walled'] = boardMap.walled;
    }
    if (listing !== undefined) {
        desc['pieces'] = listing;
        if (compact)
            desc['piecesNote'] = 'Only the opposing side is listed here; your own pieces appear in legalMoves with their coordinates.';
    }
    // Rules that change how the position should be judged.
    const rules = {};
    const winConditions = namePlayerGroup(gf.gameRules.winConditions);
    if (winConditions !== undefined)
        rules['winConditions'] = winConditions;
    const promotionRanks = namePlayerGroup(gf.gameRules.promotionRanks);
    if (promotionRanks !== undefined)
        rules['promotionRanks'] = promotionRanks;
    const promotionsAllowed = namePlayerGroup(gf.gameRules.promotionsAllowed);
    if (promotionsAllowed !== undefined) {
        // Convert raw type numbers into readable names.
        const readable = {};
        for (const color of Object.keys(promotionsAllowed)) {
            const list = promotionsAllowed[color];
            if (Array.isArray(list))
                readable[color] = list.map((t) => typeutil.getRawTypeStr(t));
        }
        rules['promotionsAllowed'] = readable;
    }
    if (gf.gameRules.moveRule !== undefined) {
        rules['moveRule'] = `${gf.state.global.moveRuleState ?? 0}/${gf.gameRules.moveRule} half-moves without a capture or pawn move`;
    }
    if (gf.gameRules.slideLimit !== undefined)
        rules['slideLimit'] = gf.gameRules.slideLimit;
    rules['turnOrder'] = turnOrder.map((p) => colorName(p));
    desc['rules'] = rules;
    // En passant, if a pawn just double-stepped.
    const enpassant = gf.state.global.enpassant;
    if (enpassant !== undefined && enpassant !== null) {
        desc['enpassant'] = { captureSquare: enpassant.square, vulnerablePawn: enpassant.pawn };
    }
    // The project's own notation for the whole position, as a cross-check.
    // Pieces marked '+' still hold their special right (castling / double-step).
    // Skipped in compact mode: it says the same thing as `pieces` a second time.
    if (includeListing && !compact) {
        try {
            const position = organizedpieces.generatePositionFromPieces(gf.pieces);
            desc['icnPosition'] = icnconverter.getShortFormPosition(position, gf.state.global.specialRights);
        }
        catch {
            // Not worth failing the whole analysis over. The piece listing above is enough.
        }
    }
    if (notes.length > 0)
        desc['payloadNotes'] = notes;
    return desc;
}
// The user's own persona -------------------------------------------------------------
/**
 * The contents of `tsc.md`, or `''` when there is no persona to apply.
 *
 * Kept in memory only. It is fetched from our own server rather than bundled, so the
 * player can edit `tsc.md`, reopen the panel, and see the change without a rebuild.
 */
let persona = '';
/** Undefined until the first fetch, so we don't re-request a file that isn't there. */
let personaLoaded = false;
/** True when the last attempt to read `tsc.md` failed outright, as opposed to finding it absent. */
let personaError;
/**
 * Reads `tsc.md` through our own server, at most once per page load.
 *
 * Never throws. A missing or unreadable persona file is not a reason to break the coach —
 * it just means the built-in prompts are used unchanged.
 * @returns True when there is a persona to apply
 */
async function loadPersona() {
    if (personaLoaded)
        return persona !== '';
    personaLoaded = true;
    try {
        const response = await fetch('/api/ai-coach/persona', { headers: { 'is-fetch-request': 'true' } });
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        persona = typeof json?.text === 'string' ? json.text.trim() : '';
        personaError = undefined;
    }
    catch (error) {
        persona = '';
        personaError = error?.message ?? 'Request failed.';
        console.warn(`AI Coach: could not read the persona file. ${personaError}`);
    }
    return persona !== '';
}
/** Why the persona couldn't be read, if that's what happened. `undefined` when the file is simply absent. */
function getPersonaError() {
    return personaError;
}
// Prompts -------------------------------------------------------------
/**
 * The board and notation rules. True of every position, whichever shape we described
 * it in, so all four prompts start from this.
 */
const RULES_BOARD = `INFINITE CHESS (infinitechess.org) is chess played on a board with no edges.

BOARD AND NOTATION
- Squares are integer coordinate pairs [x, y]. There is no a1-h8 and no FEN; algebraic notation does not apply.
- The board is unbounded in all four directions. Coordinates may be negative or very large.
- White's pawns move toward +y. Black's pawns move toward -y.
- A move is written as a from-square and a to-square, e.g. from [4,2] to [4,4].`;
/** How to read the general `moveFormat: "ranges"` description. */
const RULES_SLIDE_DATA = `HOW LEGAL MOVES ARE GIVEN TO YOU
For each of the mover's pieces you receive:
- "at": the piece's current square.
- "jumpTo": a complete list of squares it may jump to.
- "slideRanges": an object keyed by a direction vector "dx,dy". The value is [minSteps, maxSteps].
  The reachable squares along that direction are [x + n*dx, y + n*dy] for every integer n with
  minSteps <= n <= maxSteps and n != 0. "inf" and "-inf" mean unbounded in that direction.
  Note these are STEP COUNTS, not coordinates. A rook at [4,1] with "1,0": [-3, "inf"] can reach
  [1,1], [2,1], [3,1], and every square [5,1], [6,1], [7,1], ... with no upper bound.
- "canCapture": squares holding an enemy piece that this piece can capture right now.
This data is exhaustive and already excludes moves that would leave the mover in check.
Any move NOT derivable from this data is illegal. Never invent one.`;
/**
 * How to read the fast `moveFormat: "list"` description.
 *
 * The important line is the one telling the model to copy a string rather than compute
 * coordinates. Coordinate arithmetic is where these replies go wrong, and here there
 * is none left to do.
 */
const RULES_EXACT_DATA = `HOW THE POSITION IS GIVEN TO YOU
- "board" is a picture of the position. Read it with "boardLegend".
- "legalMoves" is the COMPLETE list of every move that is legal right now, each written as
  "fromX,fromY>toX,toY" — for example "4,2>4,4" means the piece on [4,2] moves to [4,4].
  Moves that would leave you in check are already excluded. Castling and en passant are already
  included where they apply.
- "capturingMoves" and "promotingMoves" are the entries from that list that capture a piece or
  promote a pawn, repeated for emphasis.
CHOOSE BY COPYING A STRING FROM "legalMoves", CHARACTER FOR CHARACTER. Do not compute coordinates
yourself and do not adjust a string. Any move that is not in the list is illegal.`;
/** The variant traits that matter on an edgeless board. */
const RULES_UNBOUNDED = `WHAT MATTERS IN THIS VARIANT
- There are no walls, so kings cannot be trapped against an edge and back-rank mates do not exist.
- Long diagonals and files are unlimited: rooks, bishops and queens are far more dangerous than in
  classical chess, and pieces are easy to fork or skewer from very far away.
- A piece's rear is usually undefended. Watch for long-range attacks arriving from behind.
- Pawns still promote, but only on the promotion ranks listed in the rules.`;
/**
 * The same, for a position walled in by voids. Worth saying explicitly: this fork
 * defaults to the walled 8x8 board, where the generic "no edges" advice above is
 * actively wrong — back-rank mates are real again.
 */
const RULES_WALLED = `WHAT MATTERS IN THIS POSITION
- This board is WALLED. The "##" squares are voids: no piece may stand on one or slide through one,
  so the playable area is finite and behaves like an ordinary chessboard.
- That means edges exist here. Kings can be trapped against the wall, back-rank mates are real, and
  a piece in a corner has very few squares.
- Everything already legal is in "legalMoves"; you never need to reason about whether a square is
  inside the wall.
- Pawns promote on the promotion ranks listed in the rules.`;
/**
 * The variant explanation. Shared verbatim by the coach and the chat box, so the two
 * can never end up believing different rules.
 */
const RULES_PRIMER = `${RULES_BOARD}

${RULES_SLIDE_DATA}

${RULES_UNBOUNDED}`;
const SYSTEM_PROMPT = `You are a chess coach. You analyze the position for the player who is to move.

${RULES_PRIMER}

OUTPUT FORMAT
Reply with a single JSON object and nothing else. No markdown fences, no prose outside the JSON.
{
  "assessment": "one or two sentences on who stands better and why",
  "threats": ["each concrete threat the opponent has right now"],
  "bestMove": { "from": [x, y], "to": [x, y] },
  "reasoning": "why this move, in two or three sentences",
  "alternatives": [ { "from": [x, y], "to": [x, y], "note": "short reason" } ]
}
"bestMove" must be one of the legal moves in the data you were given. Coordinates must be integers.
Keep "alternatives" to at most two entries. Write "assessment", "reasoning" and "threats" in the
same language the user writes to you in.`;
/** The user turn: the position, plus an optional correction from a failed attempt. */
function buildUserPrompt(desc, language, retryHint) {
    const parts = [];
    parts.push(`Here is the current position. Analyze it for ${desc['toMove']}, who is to move.`);
    parts.push('```json\n' + JSON.stringify(desc) + '\n```');
    if (retryHint !== undefined)
        parts.push(retryHint);
    parts.push(`Write the prose fields in this language: ${language}. Reply with the JSON object only.`);
    return parts.join('\n\n');
}
/** Judgement advice shared by both opponent output shapes. */
const OPPONENT_HOW_TO_CHOOSE = `HOW TO CHOOSE
Play to win, but play a move you can actually justify from the data you were given.
Prefer a safe developing move over a speculative one. Check that the square you move to is not
defended by a piece you overlooked — in this variant attacks arrive from very far away.`;
/** The extra warning that only makes sense when there are no walls to stop a piece. */
const OPPONENT_STAY_NEAR = `Keep your pieces near the fight. The board has no edges, so a rook can slide a hundred squares into
empty space; that is legal and almost always losing, because the piece stops defending anything and
takes many moves to come back. Unless you are capturing something or delivering a real threat, move
one or two squares, and stay within a few squares of the other pieces.`;
/**
 * Builds the opponent's system prompt to match the shape of the position it's about
 * to be shown.
 *
 * Two things vary. Whether the legal moves arrived as a finished list or as ranges
 * decides the whole output format — a list means the reply is a copied string and
 * there is no arithmetic to explain, which makes this prompt substantially shorter
 * as well as easier to follow. And whether the board is walled decides which set of
 * positional facts is true; telling the model "back-rank mates do not exist" while
 * it plays a walled 8x8 is worse than telling it nothing.
 */
function buildOpponentSystemPrompt(desc) {
    const exact = desc['moveFormat'] === 'list';
    const walled = desc['walled'] === true;
    const parts = [
        'You are playing a game of chess against a human opponent, and it is your turn to move.',
        RULES_BOARD,
        exact ? RULES_EXACT_DATA : RULES_SLIDE_DATA,
        walled ? RULES_WALLED : RULES_UNBOUNDED,
        walled ? OPPONENT_HOW_TO_CHOOSE : `${OPPONENT_HOW_TO_CHOOSE}\n${OPPONENT_STAY_NEAR}`,
    ];
    // The player's remembered rating, when we have one. This is what "spar at my level"
    // actually means on this path: it changes how hard the opponent tries, nothing else.
    const profileBlock = buildOpponentProfileBlock();
    if (profileBlock !== '')
        parts.push(profileBlock);
    if (exact) {
        parts.push(`OUTPUT FORMAT
Reply with a single JSON object and nothing else. No markdown fences, no prose outside the JSON.
{
  "moves": ["4,2>4,4", "7,1>6,3"],
  "comment": "one short friendly sentence to your opponent about your first choice"
}
"moves" holds up to ${MOVE_CANDIDATES_REQUESTED} strings copied EXACTLY from "legalMoves", BEST FIRST.
Your opponent's program plays the first one it can, so the ordering is what decides your move. Give at
least two unless only one legal move exists. If a move appears in "promotingMoves", write it as
"4,7>4,8=Q" — the same string with "=" and the piece letter appended, using a piece from the rules'
promotionsAllowed. "comment" is at most one sentence.`);
    }
    else {
        parts.push(`OUTPUT FORMAT
Reply with a single JSON object and nothing else. No markdown fences, no prose outside the JSON.
{
  "candidates": [
    { "from": [x, y], "to": [x, y], "promotion": "queen" },
    { "from": [x, y], "to": [x, y] }
  ],
  "comment": "one short friendly sentence to your opponent about your first choice"
}
Give up to ${MOVE_CANDIDATES_REQUESTED} candidates, BEST FIRST. Your opponent's program plays the first
one that validates locally, so the ordering is what decides your move. Give at least two unless only
one legal move exists. Every "from" must be one of your own pieces and every "to" must be reachable by
it according to the legal-move data. Coordinates must be integers. Include "promotion" only on a
candidate that promotes a pawn; use one of the names listed in the rules' promotionsAllowed.
"comment" is at most one sentence.`);
    }
    return parts.join('\n\n');
}
/** The user turn for the opponent. `rejected` grows with each illegal attempt. */
function buildOpponentPrompt(desc, language, rejected) {
    const parts = [];
    parts.push(`You are playing as ${desc['toMove']} and it is your move. Here is the position.`);
    parts.push('```json\n' + JSON.stringify(desc) + '\n```');
    if (rejected.length > 0) {
        parts.push(`Every candidate in your previous ${rejected.length === 1 ? 'reply' : 'replies'} was rejected as illegal:\n`
            + rejected.map((reason) => `- ${reason}`).join('\n')
            + '\n\nRe-read the "legalMoves" data and give moves that appear in it, copied exactly. Do not repeat a rejected move.');
    }
    parts.push(`Write "comment" in this language: ${language}. Reply with the JSON object only.`);
    return parts.join('\n\n');
}
const CHAT_SYSTEM_PROMPT = `You are a friendly chess coach, answering a player's questions while their game is in progress.

${RULES_PRIMER}

HOW TO ANSWER
- Write plain prose. No JSON, no markdown fences, no code blocks.
- Be brief: a short paragraph, or a few short bullet points. The answer is read in a narrow side panel.
- When you name a square, write it as [x,y] so the player can find it.
- Only claim a move is possible if the legal-move data supports it. If you aren't sure, say so.
- Each of the player's questions may come with a fresh position snapshot. The last snapshot in the
  conversation is the current position; earlier ones are history.
- Answer in the same language the player writes to you in.`;
/**
 * Wraps the persona the user keeps in `tsc.md`.
 *
 * The persona goes FIRST and the game's own facts go after it, because a model that
 * sees two conflicting instructions tends to follow the later one — and they do
 * conflict: a persona written for ordinary chess asks for SAN, FEN and an 8-file
 * board, none of which exist here. The character is the user's to decide; the
 * notation isn't.
 */
const PERSONA_HEADER = `THE COACH YOU ARE PLAYING
The player has written the following persona for you. Adopt its character, its teaching
method and its language.

--- BEGIN PERSONA ---`;
const PERSONA_FOOTER = `--- END PERSONA ---

WHERE THE PERSONA IS WRONG ABOUT THIS GAME
The persona may ask for standard algebraic notation, FEN, PGN, or an 8-file a1-h8 board.
None of those exist here. This is infinite chess: squares are integer [x,y] pairs and the
position reaches you as JSON. Keep the persona's voice, its adaptive-difficulty rules and
its teaching method, but name every square and move as [x,y]. Never invent a FEN or a PGN.
Where the persona and the rules below disagree, the rules below win.`;
/**
 * The stored assessment, phrased for the coach's system prompt.
 *
 * Two jobs in one block: it tells the coach the interview is already done, and it hands
 * back the conclusion it reached last time so the teaching picks up where it left off
 * instead of starting from zero.
 * @returns The block, or '' when the player has never been assessed
 */
function buildProfileBlock() {
    const profile = getProfile();
    if (profile === undefined)
        return '';
    const parts = [
        'THE PLAYER\'S LEVEL — ALREADY ASSESSED',
        `- You assessed this player in an earlier session and settled on about ${profile.elo} Elo. Treat that as established.`,
        '- Do NOT run the initial skill assessment again and do not ask the assessment questions. If the player '
            + 'plays clearly above or below this level, adjust as your persona describes and say so in one line.',
    ];
    if (profile.summary !== '')
        parts.push(`- What you noted about them: ${profile.summary}`);
    return parts.join('\n');
}
/**
 * The same record, phrased for the AI opponent — which needs the number as an
 * instruction about how hard to play, not as a fact about a student.
 *
 * "Slightly stronger, never deliberately bad" is the persona's own rule. Throwing away
 * material to let the player win is the failure mode worth naming explicitly: it reads
 * as a broken engine, not as a gentle one.
 * @returns The block, or '' when the player has never been assessed
 */
function buildOpponentProfileBlock() {
    const profile = getProfile();
    if (profile === undefined)
        return '';
    const extra = profile.elo < 1200
        ? ' Keep the position simple: avoid long forcing tactical lines and deep sacrifices.'
        : '';
    return `YOUR OPPONENT'S STRENGTH
The human you are playing is about ${profile.elo} Elo. Play at roughly that level — a little above it
rather than below, so they have to work for the game but can win a good one. Choose solid, natural
moves instead of the deepest thing you can find. Never throw away material on purpose and never play
an obviously bad move to let them win.${extra}`;
}
/** The system prompt for the chat box, with the user's persona layered in when there is one. */
function buildChatSystemPrompt() {
    const base = persona === ''
        ? CHAT_SYSTEM_PROMPT
        : `${PERSONA_HEADER}\n${persona}\n${PERSONA_FOOTER}\n\n${CHAT_SYSTEM_PROMPT}`;
    const profileBlock = buildProfileBlock();
    return profileBlock === '' ? base : `${base}\n\n${profileBlock}`;
}
/**
 * The kickoff turn, sent once when the panel opens with a persona loaded.
 *
 * Two shapes. First time round it only tells the coach to *start* — what it actually asks
 * is the persona's business — plus the one thing that is ours: end the verdict with a tag
 * we can read, so this only happens once. On every later session the stored verdict is
 * handed straight back and the interview is explicitly called off.
 *
 * The "one message, then wait" part is ours too. A coach that fired three questions across
 * three replies would look broken in a side panel the player can only answer once.
 */
function buildKickoffPrompt(language) {
    const profile = getProfile();
    if (profile !== undefined) {
        return `Start the session now, but SKIP the initial skill assessment — you have already done it. `
            + `My level is on record: about ${profile.elo} Elo`
            + (profile.summary === '' ? '' : `, and what you noted about me was: ${profile.summary}`)
            + `.\n\n`
            + `Greet me briefly in character, say in one line what strength you are pitching the game at, and `
            + `invite me to make my move. Do NOT ask me the assessment questions again, and do not analyze the `
            + `board yet. Two or three sentences in total. Write in ${language}.`;
    }
    return `Start the session now. Introduce yourself in character, briefly, then begin the initial `
        + `skill assessment your persona describes: ask me the questions you need in order to judge `
        + `my playing strength and set my level.\n\n`
        + `Put the introduction and all of the questions in ONE short message, with the questions `
        + `numbered, then stop and wait for my answer. Do not analyze the board yet, and do not `
        + `answer the questions for me. Write in ${language}.\n\n`
        + `Then, once I have answered, decide on my rating and end THAT reply — not this one — with the `
        + `tag <<ELO:n>>, where n is the number you settled on. For example: <<ELO:1450>>. Write it exactly `
        + `in that form, in digits. My program reads that tag and remembers the answer, which is what saves `
        + `me from sitting through this assessment again next game.`;
}
/** The user turn for the chat box: the question, with the live position attached. */
function buildChatPrompt(question, desc, language) {
    if (desc === undefined)
        return question;
    const parts = [];
    parts.push('Current position:');
    parts.push('```json\n' + JSON.stringify(desc) + '\n```');
    parts.push(`My question (answer in ${language}): ${question}`);
    return parts.join('\n\n');
}
/**
 * The user turn behind an unprompted coaching comment.
 *
 * The player never wrote this, so it's pushed into the history hidden — but it does go
 * into the history, because the coach's next comment should know what it already said
 * and not repeat the same criticism every round.
 *
 * `final` switches it from "comment on the move I just played" to a short post-mortem
 * of the whole game.
 */
function buildCritiquePrompt(desc, language, final) {
    const parts = [];
    if (desc !== undefined) {
        parts.push('Current position:');
        parts.push('```json\n' + JSON.stringify(desc) + '\n```');
    }
    if (final) {
        parts.push(`The game is over. Give me a short review of how I played: the one or two habits that `
            + `cost me the most, and the single thing to work on next game. Three or four sentences.`);
    }
    else {
        parts.push(`I just moved. Without being asked, tell me what you think of my play so far: `
            + `the weakness or mistake that matters most right now, and what I should be doing about it. `
            + `Be concrete and name squares as [x,y]. Two or three sentences — you are talking over my `
            + `shoulder mid-game, not writing a lesson. If my last move was fine, say so in one line and `
            + `point at the thing I am still not paying attention to. Do not repeat a point you have `
            + `already made in this conversation.`);
    }
    parts.push(`Write in ${language}.`);
    return parts.join('\n\n');
}
// Talking to the proxy -------------------------------------------------------------
/**
 * A failure that came back from (or on the way to) the proxy.
 *
 * `timedOut` is the field that matters. "The endpoint never answered" and "the endpoint
 * answered with something unusable" look identical to a player watching a random move
 * get played, but they have completely different fixes — one is a wrong URL or an
 * overloaded relay, the other is a model that can't follow the format.
 */
class ProxyError extends Error {
    timedOut;
    constructor(message, timedOut = false) {
        super(message);
        this.name = 'ProxyError';
        this.timedOut = timedOut;
    }
}
/**
 * Posts a conversation to our own server, which forwards it to the configured endpoint.
 * Same-origin, so the CSP (`default-src 'self'`, no `connect-src`) allows it.
 * @param system - The system prompt
 * @param messages - The conversation so far. Must end on a 'user' turn.
 * @param overrides - Per-call model / reasoning-effort / timeout overrides. The AI
 * opponent uses these to run its move requests on a faster model and a much shorter
 * deadline than the coach.
 * @returns The model's reply text
 * @throws {ProxyError} If the config is incomplete, or the server/upstream reports a failure
 */
async function callProxyMessages(system, messages, overrides = {}) {
    const c = getConfig();
    if (!isConfigured())
        throw new ProxyError(translate('needs_config', 'Fill in the API URL, key and model first.'));
    const model = (overrides.model ?? '').trim() || c.model;
    const reasoningEffort = overrides.reasoningEffort ?? c.reasoningEffort;
    const timeoutMillis = overrides.timeoutMillis;
    // Our proxy owns the real deadline. This one only stops a wedged local server from
    // hanging the turn, so it sits deliberately just past the proxy's own budget.
    const controller = new AbortController();
    const abortAfter = timeoutMillis === undefined ? undefined : timeoutMillis + PROXY_TIMEOUT_SLACK_MILLIS;
    const abortID = abortAfter === undefined ? undefined : setTimeout(() => controller.abort(), abortAfter);
    let response;
    try {
        response = await fetch('/api/ai-coach', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'is-fetch-request': 'true', // Custom header
            },
            signal: controller.signal,
            body: JSON.stringify({
                protocol: c.protocol,
                baseUrl: c.baseUrl,
                apiKey: c.apiKey,
                model,
                temperature: c.temperature,
                maxTokens: c.maxTokens,
                reasoningEffort,
                ...(timeoutMillis !== undefined ? { timeoutMillis } : {}),
                system,
                // `hidden` is ours, for deciding what the panel draws. Don't ship it upstream.
                messages: messages.map(({ role, content }) => ({ role, content })),
            }),
        });
    }
    catch (error) {
        if (error?.name === 'AbortError') {
            throw new ProxyError(`${translate('timed_out', 'The AI endpoint did not answer in time')} (${Math.round((abortAfter ?? 0) / 1000)}s).`, true);
        }
        throw new ProxyError(error?.message ?? 'Request failed.');
    }
    finally {
        if (abortID !== undefined)
            clearTimeout(abortID);
    }
    let json;
    try {
        json = await response.json();
    }
    catch {
        json = undefined;
    }
    if (!response.ok)
        throw new ProxyError(json?.message ?? `HTTP ${response.status}`, json?.timedOut === true);
    if (typeof json?.text !== 'string')
        throw new ProxyError('Server returned no text.');
    lastUpstreamAttempts = Number.isInteger(json.upstreamAttempts) ? json.upstreamAttempts : 1;
    return json.text;
}
/**
 * How many requests the proxy had to make upstream for the most recent reply.
 *
 * More than one means the endpoint refused a parameter set and we walked down to a
 * plainer one — which doubles the wait. Surfaced in the panel because it's the
 * difference between "the model is slow" and "we're paying for a rejected request
 * every move", and those have completely different fixes.
 */
let lastUpstreamAttempts = 1;
/** The single-turn case, which is most of them. */
async function callProxy(system, user, overrides = {}) {
    return await callProxyMessages(system, [{ role: 'user', content: user }], overrides);
}
/** Sends a throwaway prompt so the user can check their config without a game. */
async function testConnection() {
    const text = await callProxy('You are a connection test. Reply with exactly the word OK and nothing else.', 'Reply with OK.');
    return text.trim().slice(0, 200);
}
// Parsing the reply -------------------------------------------------------------
/** Accepts `[4,1]`, `"4,1"`, `"(4,1)"` or `{x:4,y:1}`. Returns undefined for anything else. */
function toCoords(value) {
    if (Array.isArray(value) && value.length >= 2) {
        const x = Number(value[0]);
        const y = Number(value[1]);
        return Number.isInteger(x) && Number.isInteger(y) ? [x, y] : undefined;
    }
    if (typeof value === 'string') {
        const match = /^\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?\s*$/.exec(value);
        if (match === null)
            return undefined;
        const x = Number(match[1] ?? NaN);
        const y = Number(match[2] ?? NaN);
        return Number.isInteger(x) && Number.isInteger(y) ? [x, y] : undefined;
    }
    if (value !== null && typeof value === 'object') {
        const x = Number(value.x);
        const y = Number(value.y);
        if (Number.isInteger(x) && Number.isInteger(y))
            return [x, y];
    }
    return undefined;
}
/** Pulls `{ from, to, note }` out of whatever shape the model used. */
function toProposedMove(value) {
    if (value === undefined || value === null || typeof value !== 'object')
        return undefined;
    const from = toCoords(value.from ?? value.startCoords ?? value.start);
    const to = toCoords(value.to ?? value.endCoords ?? value.end);
    if (from === undefined || to === undefined)
        return undefined;
    const move = { from, to };
    if (typeof value.note === 'string' && value.note !== '')
        move.note = value.note;
    return move;
}
/**
 * Extracts the JSON object out of the model's reply.
 * Models add markdown fences and commentary no matter how firmly you ask them not to,
 * so we take everything between the first `{` and the last `}`.
 */
function extractJSON(raw) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start)
        return undefined;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    }
    catch {
        return undefined;
    }
}
/** Turns the model's reply into an {@link Advice}. Never throws. */
function parseAdvice(raw) {
    const advice = {
        assessment: '',
        threats: [],
        reasoning: '',
        alternatives: [],
        raw,
    };
    const json = extractJSON(raw);
    if (json === undefined || json === null || typeof json !== 'object')
        return advice;
    if (typeof json.assessment === 'string')
        advice.assessment = json.assessment;
    if (typeof json.reasoning === 'string')
        advice.reasoning = json.reasoning;
    if (Array.isArray(json.threats)) {
        advice.threats = json.threats.filter((t) => typeof t === 'string' && t !== '');
    }
    else if (typeof json.threats === 'string' && json.threats !== '') {
        advice.threats = [json.threats];
    }
    const best = toProposedMove(json.bestMove ?? json.best_move);
    if (best !== undefined)
        advice.bestMove = best;
    if (Array.isArray(json.alternatives)) {
        for (const entry of json.alternatives) {
            const move = toProposedMove(entry);
            if (move !== undefined)
                advice.alternatives.push(move);
        }
    }
    return advice;
}
/**
 * Matches the string form of a move — the shape the fast path asks for, because
 * copying a string is the one thing a model can do without making arithmetic
 * mistakes. Accepts `>`, `->` and `to` as the separator, optional brackets, and an
 * optional `=Q` / `=queen` promotion suffix.
 */
const MOVE_STRING_REGEX = /^\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?\s*(?:>|->|to)\s*\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?\s*(?:=\s*([A-Za-z]+))?\s*$/;
/**
 * Turns a promotion abbreviation into the piece name `choosePromotion` expects.
 * A word like "queen" is already that name, so it comes back unchanged.
 */
function promotionName(raw) {
    try {
        const type = icnconverter.getTypeFromAbbr(raw);
        if (Number.isInteger(type))
            return typeutil.getRawTypeStr(typeutil.getRawType(type));
    }
    catch {
        // Not an abbreviation. It's presumably already a name.
    }
    return raw;
}
/** Parses `'4,2>4,4'` / `'4,7>4,8=Q'` into a candidate. */
function parseMoveString(value) {
    const match = MOVE_STRING_REGEX.exec(value);
    if (match === null)
        return undefined;
    const nums = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
    if (!nums.every((n) => Number.isInteger(n)))
        return undefined;
    const candidate = { from: [nums[0], nums[1]], to: [nums[2], nums[3]] };
    const promotion = match[5];
    if (promotion !== undefined && promotion !== '')
        candidate.promotion = promotionName(promotion);
    return candidate;
}
/**
 * Turns the AI opponent's reply into its ranked list of candidate moves. Never throws.
 *
 * Both output shapes are accepted — a list of `'from>to'` strings (what the fast path
 * asks for) and a list of `{ from, to }` objects — as are the older single-move form
 * and the container keys models like to wrap a move in even when told not to. A model
 * that ignores the requested format still produces a playable move.
 * @returns The candidates best-first, plus the reply's comment. Empty list if nothing parsed.
 */
function parseChosenMoves(raw) {
    const json = extractJSON(raw);
    if (json === undefined || json === null || typeof json !== 'object')
        return { candidates: [] };
    const result = { candidates: [] };
    const topComment = json.comment ?? json.note ?? json.message;
    if (typeof topComment === 'string' && topComment !== '')
        result.comment = topComment.slice(0, 400);
    /** Pushes an entry if it parses into a move, skipping duplicates. */
    function consider(entry) {
        let move;
        if (typeof entry === 'string') {
            move = parseMoveString(entry);
        }
        else if (entry !== undefined && entry !== null && typeof entry === 'object') {
            // A `move` key holding the string form is common enough to be worth catching.
            if (typeof entry.move === 'string')
                move = parseMoveString(entry.move);
            if (move === undefined) {
                const from = toCoords(entry.from ?? entry.startCoords ?? entry.start);
                const to = toCoords(entry.to ?? entry.endCoords ?? entry.end);
                if (from !== undefined && to !== undefined)
                    move = { from, to };
            }
            if (move !== undefined) {
                const promotion = entry.promotion ?? json.promotion;
                if (typeof promotion === 'string' && promotion !== '')
                    move.promotion = promotionName(promotion);
            }
        }
        if (move === undefined)
            return;
        if (result.candidates.some((c) => coordutil.areCoordsEqual_noValidate(c.from, move.from)
            && coordutil.areCoordsEqual_noValidate(c.to, move.to)))
            return;
        result.candidates.push(move);
        if (result.comment === undefined && typeof entry?.comment === 'string' && entry.comment !== '') {
            result.comment = entry.comment.slice(0, 400);
        }
    }
    // The requested shape, ranked best-first. `moves` is the string list; `candidates` the object list.
    const listed = json.moves ?? json.candidates ?? json.candidateMoves ?? json.candidate_moves;
    if (Array.isArray(listed))
        for (const entry of listed)
            consider(entry);
    // Backwards compatible: a single move, at the top level or inside a container key.
    for (const container of [json, json.move, json.bestMove, json.best_move, json.chosenMove, json.chosen_move]) {
        consider(container);
    }
    return result;
}
// Validating the suggested move -------------------------------------------------------------
/**
 * Confirms a move the model proposed is actually playable in the current position.
 *
 * We can't trust the model here. This variant has essentially no training data,
 * and pure coordinate arithmetic is exactly the kind of thing LLMs get wrong.
 * @returns `undefined` if the move is legal, otherwise the reason it isn't
 */
function validateMove(gf, from, to) {
    if (!coordutil.areCoordsIntegers(from) || !coordutil.areCoordsIntegers(to)) {
        return 'coordinates must be integers';
    }
    if (coordutil.areCoordsEqual_noValidate(from, to))
        return 'the from and to squares are the same';
    const piece = boardutil.getPieceFromCoords(gf.pieces, from);
    if (piece === undefined)
        return `there is no piece on [${from[0]},${from[1]}]`;
    const color = typeutil.getColorFromType(piece.type);
    if (color !== gf.whosTurn)
        return `the piece on [${from[0]},${from[1]}] is not yours to move`;
    const legalMoves = legalmoves.calculate(gf, piece);
    // checkIfMoveLegal writes special-move flags onto the end coords, so hand it a copy.
    const endCoords = coordutil.copyCoords(to);
    const legal = legalmoves.checkIfMoveLegal(gf, legalMoves, piece.coords, endCoords, color);
    if (!legal)
        return `${typeutil.getRawTypeStr(typeutil.getRawType(piece.type))} on [${from[0]},${from[1]}] cannot reach [${to[0]},${to[1]}]`;
    return undefined;
}
// Building a real move -------------------------------------------------------------
/**
 * Decides what a promoting pawn becomes.
 *
 * The model names the piece in words ("queen"), but the engine wants a colored
 * type number, and the variant decides which pieces are even allowed.
 * @returns The colored type to promote to, or undefined if this variant forbids promotion
 */
function choosePromotion(gf, color, requested) {
    const allowed = gf.gameRules?.promotionsAllowed?.[color];
    if (allowed === undefined || allowed.length === 0)
        return undefined;
    if (requested !== undefined) {
        const wanted = requested.trim().toLowerCase();
        for (const raw of allowed) {
            if (typeutil.getRawTypeStr(raw).toLowerCase() === wanted)
                return typeutil.buildType(raw, color);
        }
    }
    // The model asked for nothing, or for something this variant doesn't offer.
    for (const preferred of PROMOTION_PREFERENCE) {
        if (allowed.includes(preferred))
            return typeutil.buildType(preferred, color);
    }
    return typeutil.buildType(allowed[0], color);
}
/**
 * Validates a from/to pair and, when it's legal, returns the move that plays it.
 *
 * Mirrors `selection.moveGamefilePiece` for a human move: `checkIfMoveLegal`
 * attaches its special-move flags to the destination coords, we resolve any
 * promotion, then the flags get transferred onto the draft. Skipping that dance
 * would silently break castling, en passant and promotion.
 * @returns `{ draft }` when playable, `{ reason }` explaining why not otherwise
 */
function buildMoveDraft(gf, from, to, promotion) {
    if (!coordutil.areCoordsIntegers(from) || !coordutil.areCoordsIntegers(to)) {
        return { reason: 'coordinates must be integers' };
    }
    if (coordutil.areCoordsEqual_noValidate(from, to))
        return { reason: 'the from and to squares are the same' };
    const piece = boardutil.getPieceFromCoords(gf.pieces, from);
    if (piece === undefined)
        return { reason: `there is no piece on [${from[0]},${from[1]}]` };
    const color = typeutil.getColorFromType(piece.type);
    if (color !== gf.whosTurn)
        return { reason: `the piece on [${from[0]},${from[1]}] is not yours to move` };
    const legalMoves = legalmoves.calculate(gf, piece);
    const coords = coordutil.copyCoords(to);
    if (!legalmoves.checkIfMoveLegal(gf, legalMoves, piece.coords, coords, color)) {
        const name = typeutil.getRawTypeStr(typeutil.getRawType(piece.type));
        return { reason: `the ${name} on [${from[0]},${from[1]}] cannot reach [${to[0]},${to[1]}]` };
    }
    if (coords.promoteTrigger) {
        const promoteTo = choosePromotion(gf, color, promotion);
        if (promoteTo === undefined) {
            return { reason: `[${to[0]},${to[1]}] is a promotion square but this variant allows no promotions` };
        }
        delete coords.promoteTrigger;
        coords.promotion = promoteTo;
    }
    const draft = {
        startCoords: piece.coords,
        endCoords: moveutil.stripSpecialMoveTagsFromCoords(coords),
    };
    specialdetect.transferSpecialFlags_FromCoordsToMove(coords, draft);
    return { draft };
}
/**
 * Collects destinations we're willing to try for a random move.
 *
 * Sliding destinations are infinite, so we only walk out {@link RANDOM_SLIDE_REACH}
 * steps in each direction. That's plenty — this is a last resort, not a strategy.
 */
function collectCandidateDestinations(from, legalMoves) {
    const out = [];
    if (Array.isArray(legalMoves?.individual)) {
        for (const coords of legalMoves.individual) {
            if (Array.isArray(coords) && coords.length >= 2)
                out.push([Number(coords[0]), Number(coords[1])]);
        }
    }
    const sliding = legalMoves?.sliding;
    if (sliding !== undefined && sliding !== null) {
        for (const key of Object.keys(sliding)) {
            const direction = coordutil.getCoordsFromKey(key);
            const range = sliding[key];
            if (!Array.isArray(range))
                continue;
            const min = Math.max(Number(range[0]), -RANDOM_SLIDE_REACH);
            const max = Math.min(Number(range[1]), RANDOM_SLIDE_REACH);
            for (let n = min; n <= max; n++) {
                if (n === 0)
                    continue;
                out.push([from[0] + n * direction[0], from[1] + n * direction[1]]);
            }
        }
    }
    return out;
}
/**
 * Finds *some* legal move, so the game can never deadlock on a model that refuses
 * to produce one. Deliberately dumb: it plays whatever validates first from a
 * shuffled list, except that it won't fling a piece off into empty space unless
 * that's genuinely all there is.
 */
function pickRandomLegalMove(gf) {
    const mover = gf.whosTurn;
    // Same walk `collectLegalMoves` does: every type range belonging to the mover.
    const candidates = [];
    for (const rawType of Object.values(rawTypes)) {
        const range = gf.pieces.typeRanges.get(typeutil.buildType(rawType, mover));
        if (!range)
            continue;
        for (let idx = range.start; idx < range.end; idx++) {
            const piece = boardutil.getPieceFromIdx(gf.pieces, idx);
            if (piece)
                candidates.push(piece);
        }
    }
    let wanderingFallback;
    for (const piece of shuffled(candidates)) {
        const legalMoves = legalmoves.calculate(gf, piece);
        if (!legalmoves.hasAtleast1Move(legalMoves))
            continue;
        for (const to of shuffled(collectCandidateDestinations(piece.coords, legalMoves))) {
            const { draft } = buildMoveDraft(gf, piece.coords, to);
            if (draft === undefined)
                continue;
            if (!isWanderingMove(gf, piece.coords, to))
                return draft;
            wanderingFallback ??= draft; // Remember it, but keep looking for something local
        }
    }
    return wanderingFallback;
}
/** Fisher-Yates on a copy. */
function shuffled(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
// State -------------------------------------------------------------
/** The move currently highlighted on the board, if any. */
let suggestion;
/** The most recent advice, for the panel to redisplay after reopening. */
let latestAdvice;
/** Guards against firing a second request while one is still running. */
let requestInFlight = false;
/**
 * The chat transcript. Only the plain questions and answers are kept — the
 * position snapshot is attached to the outgoing request instead, so the history
 * doesn't grow by a whole board every turn.
 */
let chatHistory = [];
/**
 * The move to highlight. Pass the gamefile to have a stale suggestion
 * (one generated before the position changed) discarded automatically.
 */
function getSuggestion(gf) {
    if (suggestion === undefined)
        return undefined;
    if (gf !== undefined && gf.moves.length !== suggestion.moveCount) {
        suggestion = undefined;
        return undefined;
    }
    return suggestion;
}
function getLatestAdvice() {
    return latestAdvice;
}
function isRequestInFlight() {
    return requestInFlight;
}
/** Drops the highlight and the stored advice. The player's assessed level survives. */
function clear() {
    suggestion = undefined;
    latestAdvice = undefined;
    chatHistory = [];
    coachSessionStarted = false;
}
function getChatHistory() {
    return chatHistory;
}
function clearChat() {
    chatHistory = [];
    // The player asked for a clean slate, so the coach should introduce itself and
    // re-assess next time the panel opens rather than carrying on mid-conversation.
    coachSessionStarted = false;
    // The assessed level is NOT cleared here. Wiping the chat is a routine thing to do;
    // re-sitting the interview because of it would be a punishment. `clearProfile` is
    // the deliberate way to drop it, behind the panel's re-assess button.
}
/** Appends a turn, trimming the oldest so the replayed history stays bounded. */
function pushChatMessage(role, content, hidden = false) {
    chatHistory.push(hidden ? { role, content, hidden } : { role, content });
    if (chatHistory.length > MAX_CHAT_HISTORY)
        chatHistory.splice(0, chatHistory.length - MAX_CHAT_HISTORY);
}
/** True once the coach has introduced itself, so opening the panel again doesn't restart it. */
let coachSessionStarted = false;
/** True while the kickoff request is in flight, so two panel opens can't both fire it. */
let coachSessionStarting = false;
/**
 * Opens the coaching session: the coach introduces itself and asks how strong the player is.
 *
 * Only runs when there is actually a persona in `tsc.md` to base it on — with no persona
 * there is nothing to introduce, and a surprise question on every panel open would be
 * worse than silence.
 *
 * The kickoff instruction itself is stored `hidden`, so the model keeps the persona and
 * the assessment in context for every later question, but the player never sees a turn
 * they didn't write.
 * @returns The coach's opening message, or undefined when there was nothing to do
 * @throws {ProxyError} If the request fails
 */
async function startCoachSession() {
    if (coachSessionStarted || coachSessionStarting)
        return undefined;
    if (!isConfigured())
        return undefined;
    if (chatHistory.length > 0) {
        coachSessionStarted = true;
        return undefined;
    } // Mid-conversation already
    if (!await loadPersona())
        return undefined;
    coachSessionStarting = true;
    try {
        const language = document.documentElement.lang || 'en-US';
        const kickoff = buildKickoffPrompt(language);
        // The prose fallback is off here: this reply is the coach *asking* about ratings,
        // so any number in it is an example ("600-2400"), not a verdict.
        const greeting = absorbAssessment((await callProxyMessages(buildChatSystemPrompt(), [{ role: 'user', content: kickoff }])).trim(), false);
        // Only now, so a failed request leaves the session unstarted and retryable.
        coachSessionStarted = true;
        pushChatMessage('user', kickoff, true);
        pushChatMessage('assistant', greeting);
        return greeting;
    }
    finally {
        coachSessionStarting = false;
    }
}
// The main flow -------------------------------------------------------------
/**
 * Describes the position, asks the model, validates what comes back.
 *
 * If the suggested move turns out to be illegal we tell the model why and ask
 * once more. That single retry catches most of its coordinate slips. If the
 * second attempt is also illegal we keep the prose and drop the highlight,
 * rather than pointing at a move that can't be played.
 * @throws If not configured, not viewing the live position, or the request fails
 */
async function requestAdvice(gf) {
    if (requestInFlight)
        throw new Error(translate('busy', 'An analysis is already running.'));
    if (!moveutil.areWeViewingLatestMove(gf)) {
        throw new Error(translate('not_at_front', 'Fast-forward to the latest move before analyzing.'));
    }
    requestInFlight = true;
    try {
        const moveCountAtRequest = gf.moves.length;
        const desc = describePosition(gf);
        const language = document.documentElement.lang || 'en-US';
        let advice = parseAdvice(await callProxy(SYSTEM_PROMPT, buildUserPrompt(desc, language)));
        // Validate, and give the model one chance to correct itself.
        if (advice.bestMove !== undefined) {
            const reason = validateMove(gf, advice.bestMove.from, advice.bestMove.to);
            if (reason !== undefined) {
                const rejected = advice.bestMove;
                const hint = `Your previous answer suggested from [${rejected.from[0]},${rejected.from[1]}] to [${rejected.to[0]},${rejected.to[1]}], which is ILLEGAL: ${reason}. Re-read the "legalMoves" data — remember slideRanges are step counts along the direction vector, so a destination is [x + n*dx, y + n*dy]. Pick a different move that the data actually permits.`;
                const retried = parseAdvice(await callProxy(SYSTEM_PROMPT, buildUserPrompt(desc, language, hint)));
                // Keep the retry only if it's an improvement.
                if (retried.bestMove !== undefined && validateMove(gf, retried.bestMove.from, retried.bestMove.to) === undefined) {
                    advice = retried;
                }
                else {
                    if (retried.assessment !== '')
                        advice = { ...retried, bestMove: advice.bestMove };
                    advice.rejectedMove = `[${rejected.from[0]},${rejected.from[1]}] → [${rejected.to[0]},${rejected.to[1]}]: ${reason}`;
                    delete advice.bestMove;
                }
            }
        }
        // Alternatives get checked too, but silently — illegal ones are just dropped.
        advice.alternatives = advice.alternatives.filter((move) => validateMove(gf, move.from, move.to) === undefined);
        latestAdvice = advice;
        suggestion = advice.bestMove === undefined
            ? undefined
            : { from: advice.bestMove.from, to: advice.bestMove.to, moveCount: moveCountAtRequest };
        return advice;
    }
    finally {
        requestInFlight = false;
    }
}
/**
 * The bounding box of every piece on the board, plus how far outside it a
 * destination may sit before we call the move a wander.
 *
 * There is no "off the board" in this variant, so this box is the closest thing
 * to an edge that actually exists: it's where the pieces are, which is also
 * everything the player can see at a normal zoom level.
 */
function occupiedBounds(gf) {
    let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
    for (const range of gf.pieces.typeRanges.values()) {
        for (let idx = range.start; idx < range.end; idx++) {
            const piece = boardutil.getPieceFromIdx(gf.pieces, idx);
            if (!piece)
                continue;
            const [x, y] = piece.coords;
            if (x < left)
                left = x;
            if (x > right)
                right = x;
            if (y < bottom)
                bottom = y;
            if (y > top)
                top = y;
        }
    }
    return { left, right, bottom, top };
}
/**
 * True when a move looks like the piece has wandered off into empty space.
 *
 * Every move we're asked about here has already passed the real legality check, so
 * this is purely about quality: on an edgeless board sliding a rook thirty squares
 * into nothing is legal, loses the piece's usefulness for many moves, and reads to
 * a human as the piece having left the board. A capture is never a wander — taking
 * something at range is exactly the kind of move this variant is about.
 */
function isWanderingMove(gf, from, to) {
    if (boardutil.getTypeFromCoords(gf.pieces, to) !== undefined)
        return false; // A capture
    const travel = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
    if (travel > COMPACT_SLIDE_HORIZON)
        return true;
    const bounds = occupiedBounds(gf);
    return to[0] < bounds.left - WANDER_MARGIN || to[0] > bounds.right + WANDER_MARGIN
        || to[1] < bounds.bottom - WANDER_MARGIN || to[1] > bounds.top + WANDER_MARGIN;
}
/**
 * Asks the model for its own move, as our opponent, and returns it ready to play.
 *
 * This is the one path the user actually waits on, so it's tuned for latency four ways:
 *
 * - The position is described in the fast shape where possible — a picture of the board
 *   plus a finished list of every legal move — so the model has no coordinate arithmetic
 *   to do and far less to read.
 * - The request can run on a separate faster model (`config.moveModel`).
 * - The model returns a *ranked list*, which we validate locally in order, so rejecting
 *   its first choice costs a local check instead of a whole round trip.
 * - It gets {@link MOVE_TIMEOUT_MILLIS}, not the proxy's two-minute default. A hung
 *   endpoint is discovered in half a minute and said out loud, rather than quietly
 *   turning into a random move after two minutes.
 *
 * Only if every candidate in a reply fails do we spend another request, up to
 * {@link MAX_MOVE_ATTEMPTS}. If it still can't manage a legal move we play a random
 * one — a game that silently stops being playable is worse than a bad move.
 * @returns The chosen move, or undefined when the position has no legal moves at all
 * @throws If not configured, or every request to the endpoint failed
 */
async function requestOpponentMove(gf) {
    const startedAt = performance.now();
    const desc = describePosition(gf, { compact: true });
    const system = buildOpponentSystemPrompt(desc);
    const language = document.documentElement.lang || 'en-US';
    const overrides = { model: getConfig().moveModel, timeoutMillis: MOVE_TIMEOUT_MILLIS };
    const rejected = [];
    let lastError;
    let upstreamAttempts = 0;
    for (let attempt = 1; attempt <= MAX_MOVE_ATTEMPTS; attempt++) {
        let raw;
        try {
            raw = await callProxy(system, buildOpponentPrompt(desc, language, rejected), overrides);
            upstreamAttempts += lastUpstreamAttempts;
        }
        catch (error) {
            // A network/config failure won't fix itself on a retry, so stop asking.
            lastError = error;
            break;
        }
        const { candidates, comment } = parseChosenMoves(raw);
        if (candidates.length === 0) {
            rejected.push('your reply did not contain a move we could read');
            continue;
        }
        // Best first. The first one that validates is the move we play.
        // Two passes: the first skips moves that wander off into empty space, the second
        // takes them anyway. So a sensible move always wins over a wandering one that the
        // model happened to rank higher, but a wandering move is still played if it's the
        // only legal thing on offer — better a silly move than a stuck game.
        const deferred = [];
        for (const pass of [0, 1]) {
            for (const candidate of pass === 0 ? candidates : deferred) {
                if (pass === 0 && isWanderingMove(gf, candidate.from, candidate.to)) {
                    deferred.push(candidate);
                    continue;
                }
                const { draft, reason } = buildMoveDraft(gf, candidate.from, candidate.to, candidate.promotion);
                if (draft === undefined) {
                    if (pass === 0)
                        rejected.push(`[${candidate.from[0]},${candidate.from[1]}] to [${candidate.to[0]},${candidate.to[1]}] — ${reason}`);
                    continue;
                }
                const meta = {
                    from: candidate.from,
                    to: candidate.to,
                    wasRandom: false,
                    attempts: attempt,
                    elapsedMillis: Math.round(performance.now() - startedAt),
                    upstreamAttempts,
                };
                if (candidate.promotion !== undefined)
                    meta.promotion = candidate.promotion;
                if (comment !== undefined)
                    meta.comment = comment;
                return { draft, meta };
            }
        }
    }
    // Out of attempts (or the endpoint is unreachable). Keep the game moving.
    const fallback = pickRandomLegalMove(gf);
    if (fallback === undefined) {
        // No legal moves exist. The game is over; the caller's conclusion check handles it.
        if (lastError !== undefined)
            throw lastError;
        return undefined;
    }
    if (lastError !== undefined)
        console.warn('AI opponent request failed, playing a random move instead.');
    const meta = {
        from: fallback.startCoords,
        to: fallback.endCoords,
        wasRandom: true,
        attempts: rejected.length,
        elapsedMillis: Math.round(performance.now() - startedAt),
        upstreamAttempts,
    };
    const failure = describeMoveFailure(lastError, rejected);
    if (failure !== undefined)
        meta.failure = failure;
    return { draft: fallback, meta };
}
/**
 * One line explaining why the AI ended up playing a random move, for the panel.
 *
 * Worth the effort because the three causes look identical from the board but need
 * completely different fixes: a hung endpoint (wrong URL, dead relay, a model too slow
 * for the move budget), some other request failure, or a model that answered promptly
 * with moves that were all illegal.
 */
function describeMoveFailure(lastError, rejected) {
    if (lastError instanceof ProxyError && lastError.timedOut) {
        return `${translate('fail_timeout', 'The AI endpoint did not answer within')} ${MOVE_TIMEOUT_MILLIS / 1000}s. `
            + translate('fail_timeout_hint', 'Check the request URL and model name, or set a faster model under "move model".');
    }
    if (lastError !== undefined) {
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        return `${translate('fail_request', 'The request to the AI failed')}: ${message}`;
    }
    if (rejected.length > 0) {
        return translate('fail_illegal', 'The AI answered, but none of the moves it named were legal.');
    }
    return undefined;
}
/**
 * Answers a free-form question about the game.
 *
 * The live position is attached to this turn only. Earlier turns keep just their
 * text, so a long conversation doesn't replay a dozen board snapshots.
 * @param gf - The gamefile, or undefined when no game is loaded
 * @returns The model's prose answer
 * @throws If not configured or the request fails
 */
async function askQuestion(gf, question) {
    const trimmed = question.trim();
    if (trimmed === '')
        throw new Error(translate('chat_empty', 'Type a question first.'));
    const language = document.documentElement.lang || 'en-US';
    const desc = gf === undefined ? undefined : describePosition(gf);
    // Cheap after the first call, and it means the persona still applies if the player
    // skipped the greeting by typing before the panel finished starting the session.
    await loadPersona();
    // Previous turns as plain text, this turn with the position attached.
    const messages = [
        ...chatHistory,
        { role: 'user', content: buildChatPrompt(trimmed, desc, language) },
    ];
    // This is the reply the coach's verdict normally arrives in — the one right after the
    // player answers the three questions. `absorbAssessment` stores the rating and takes
    // the tag out, so what gets displayed and remembered is clean prose.
    const answer = absorbAssessment((await callProxyMessages(buildChatSystemPrompt(), messages)).trim());
    pushChatMessage('user', trimmed);
    pushChatMessage('assistant', answer);
    return answer;
}
/**
 * Asks the coach to comment on the player's play, unprompted.
 *
 * Same conversation, same persona and same history as `askQuestion` — the coach should
 * remember what it already told the player and not open every round with the same
 * criticism. The difference is that the instruction behind it is pushed `hidden`, since
 * the player didn't write it and shouldn't see it in the panel.
 * @param gf - The gamefile, or undefined when no game is loaded
 * @param final - True for the end-of-game review instead of a mid-game remark
 * @returns The coach's remark
 * @throws If the request fails
 */
async function requestCritique(gf, final = false) {
    const language = document.documentElement.lang || 'en-US';
    const desc = gf === undefined ? undefined : describePosition(gf);
    await loadPersona(); // Cheap after the first call
    const prompt = buildCritiquePrompt(desc, language, final);
    const messages = [...chatHistory, { role: 'user', content: prompt }];
    // Tag-only here: a critique that happens to mention a rating is talking about the game,
    // not handing down a verdict, so the prose fallback would do more harm than good.
    const answer = absorbAssessment((await callProxyMessages(buildChatSystemPrompt(), messages)).trim(), false);
    pushChatMessage('user', prompt, true); // Hidden: the player never wrote it
    pushChatMessage('assistant', answer);
    return answer;
}
// Helpers -------------------------------------------------------------
/** Looks a string up in `[play.javascript.aicoach]`, falling back to English. */
function translate(key, fallback) {
    if (typeof translations === 'undefined')
        return fallback;
    const group = translations['aicoach'];
    const value = group === undefined || group === null ? undefined : group[key];
    return typeof value === 'string' && value !== '' ? value : fallback;
}
export default {
    getConfig,
    saveConfig,
    isConfigured,
    testConnection,
    requestAdvice,
    requestOpponentMove,
    askQuestion,
    requestCritique,
    startCoachSession,
    getPersonaError,
    getProfile,
    clearProfile,
    getChatHistory,
    pushChatMessage,
    clearChat,
    getSuggestion,
    getLatestAdvice,
    isRequestInFlight,
    clear,
    translate,
};
