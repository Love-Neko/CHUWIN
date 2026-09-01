/**
 * AI Coach — the panel.
 *
 * A side panel rather than a modal, so the board stays usable while advice is
 * on screen: you can look at the highlighted move, play it, and ask again.
 * In an AI game it doubles as the chat box you talk to your opponent through.
 *
 * All the thinking lives in `aicoach`. This script only moves strings between
 * that module and the DOM.
 */
import aicoach from '../misc/aicoach.js';
import gameslot from '../chess/gameslot.js';
import onlinegame from '../misc/onlinegame/onlinegame.js';
import enginegame from '../misc/enginegame.js';
import gamefileutility from '../../chess/util/gamefileutility.js';
import { players } from '../../chess/util/typeutil.js';
// @ts-ignore
import statustext from './statustext.js';
import frametracker from '../rendering/frametracker.js';
// Elements -------------------------------------------------------------
const element_aicoachUI = document.getElementById('aicoachUI');
const element_close = document.getElementById('aicoach-close');
const element_toggleSettings = document.getElementById('aicoach-toggle-settings');
const element_settings = document.getElementById('aicoach-settings');
const element_protocol = document.getElementById('aicoach-protocol');
const element_url = document.getElementById('aicoach-url');
const element_key = document.getElementById('aicoach-key');
const element_model = document.getElementById('aicoach-model');
const element_moveModel = document.getElementById('aicoach-move-model');
const element_reasoning = document.getElementById('aicoach-reasoning');
const element_save = document.getElementById('aicoach-save');
const element_test = document.getElementById('aicoach-test');
const element_analyze = document.getElementById('aicoach-analyze');
const element_auto = document.getElementById('aicoach-auto');
const element_autoCoach = document.getElementById('aicoach-autocoach');
const element_aimove = document.getElementById('aicoach-aimove');
const element_status = document.getElementById('aicoach-status');
const element_profile = document.getElementById('aicoach-profile');
const element_profileText = document.getElementById('aicoach-profile-text');
const element_reassess = document.getElementById('aicoach-reassess');
const element_scroll = element_aicoachUI.querySelector('.aicoach-scroll');
const element_results = document.getElementById('aicoach-results');
const element_chat = document.getElementById('aicoach-chat');
const element_question = document.getElementById('aicoach-question');
const element_send = document.getElementById('aicoach-send');
const element_clearChat = document.getElementById('aicoach-clear-chat');
/**
 * The panel sits inside #overlay, which is where the board's own input listener
 * lives. Without swallowing these, dragging in the panel would pan the board and
 * scrolling would zoom it. Keys are swallowed too, so typing a question can't
 * trigger the game's keyboard shortcuts. Bubble phase, so our own controls still work.
 */
const SWALLOWED_EVENTS = [
    'mousedown', 'mousemove', 'wheel', 'contextmenu',
    'touchstart', 'touchmove', 'keydown', 'keyup',
];
// State -------------------------------------------------------------
let isOpen = false;
/** `gamefile.moves.length` at the last analysis, so auto-analyze fires once per move. */
let lastAnalyzedMoveCount = -1;
/** Poll handle. Lets us avoid hooking into the move logic. */
let autoAnalyzeIntervalID;
/** How often the poll checks whether the position moved on. */
const AUTO_ANALYZE_POLL_MILLIS = 800;
/** True while a chat question is in flight, so we don't queue two. */
let askInFlight = false;
/**
 * `gamefile.moves.length` at the coach's last unprompted remark, so it speaks once
 * per round rather than once per poll.
 */
let lastCritiquedMoveCount = -1;
/** True while an unprompted remark is in flight. */
let critiqueInFlight = false;
/** Whether the closing review has already been given for the game on the board. */
let finalReviewDone = false;
// Open / close -------------------------------------------------------------
function areOpen() {
    return isOpen;
}
function open() {
    if (isOpen)
        return;
    isOpen = true;
    loadConfigIntoForm();
    element_aicoachUI.classList.remove('hidden');
    initListeners();
    enginegame.setAIOpponentListener(onAIOpponentEvent);
    // Redisplay whatever we last got, so reopening isn't a blank panel.
    const advice = aicoach.getLatestAdvice();
    if (advice !== undefined)
        renderAdvice(advice);
    else if (!aicoach.isConfigured()) {
        element_settings.classList.remove('hidden');
        setStatus(tr('needs_config', 'Enter your API URL, key and model, then press Save.'), false);
    }
    renderChat();
    refreshProfile();
    startPollTimer();
    frametracker.onVisualChange();
    void maybeStartCoachSession();
}
/** Opens the panel with the settings section expanded. For "you haven't configured this yet". */
function openSettings() {
    open();
    element_settings.classList.remove('hidden');
    element_url.focus();
}
function close() {
    if (!isOpen)
        return;
    isOpen = false;
    element_aicoachUI.classList.add('hidden');
    closeListeners();
    enginegame.setAIOpponentListener(undefined);
    stopPollTimer();
    frametracker.onVisualChange();
}
function toggle() {
    if (isOpen)
        close();
    else
        open();
}
/**
 * Closes the panel and throws away the stored advice and chat.
 * Call this when a game unloads — a suggestion from the previous game could
 * otherwise survive into a fresh one, since both start at move count 0.
 */
function reset() {
    close();
    aicoach.clear();
    element_results.replaceChildren();
    element_chat.replaceChildren();
    setStatus('', false);
    lastAnalyzedMoveCount = -1;
    lastCritiquedMoveCount = -1;
    finalReviewDone = false;
}
/**
 * Resets the per-game bookkeeping, but keeps the transcript.
 *
 * Called on a rematch. The chat survives on purpose — the coach persona tracks how the
 * player is doing across games, so it should remember the one just played — but the move
 * counters must not, or the coach would think it had already commented on the new game.
 */
function onNewGame() {
    lastAnalyzedMoveCount = -1;
    lastCritiquedMoveCount = -1;
    finalReviewDone = false;
}
function initListeners() {
    element_close.addEventListener('click', close);
    element_toggleSettings.addEventListener('click', callback_ToggleSettings);
    element_save.addEventListener('click', callback_Save);
    element_test.addEventListener('click', callback_Test);
    element_analyze.addEventListener('click', callback_Analyze);
    element_auto.addEventListener('change', callback_AutoChanged);
    element_autoCoach.addEventListener('change', callback_AutoCoachChanged);
    element_aimove.addEventListener('click', callback_AIMove);
    element_send.addEventListener('click', callback_Send);
    element_clearChat.addEventListener('click', callback_ClearChat);
    element_reassess.addEventListener('click', callback_Reassess);
    element_question.addEventListener('keydown', callback_QuestionKeydown);
    for (const type of SWALLOWED_EVENTS)
        element_aicoachUI.addEventListener(type, swallow);
}
function closeListeners() {
    element_close.removeEventListener('click', close);
    element_toggleSettings.removeEventListener('click', callback_ToggleSettings);
    element_save.removeEventListener('click', callback_Save);
    element_test.removeEventListener('click', callback_Test);
    element_analyze.removeEventListener('click', callback_Analyze);
    element_auto.removeEventListener('change', callback_AutoChanged);
    element_autoCoach.removeEventListener('change', callback_AutoCoachChanged);
    element_aimove.removeEventListener('click', callback_AIMove);
    element_send.removeEventListener('click', callback_Send);
    element_clearChat.removeEventListener('click', callback_ClearChat);
    element_reassess.removeEventListener('click', callback_Reassess);
    element_question.removeEventListener('keydown', callback_QuestionKeydown);
    for (const type of SWALLOWED_EVENTS)
        element_aicoachUI.removeEventListener(type, swallow);
}
function swallow(event) {
    event.stopPropagation();
}
// Config form -------------------------------------------------------------
const VALID_REASONING_EFFORTS = ['', 'minimal', 'low', 'medium', 'high'];
function loadConfigIntoForm() {
    const config = aicoach.getConfig();
    element_protocol.value = config.protocol;
    element_url.value = config.baseUrl;
    element_key.value = config.apiKey;
    element_model.value = config.model;
    element_moveModel.value = config.moveModel;
    element_reasoning.value = config.reasoningEffort;
    element_auto.checked = config.autoAnalyze;
    element_autoCoach.checked = config.autoCritique;
}
/** Reads the form back into storage. Returns false (and complains) if anything's missing. */
function saveFormIntoConfig() {
    const protocol = element_protocol.value === 'anthropic' ? 'anthropic' : 'openai';
    const effort = element_reasoning.value;
    aicoach.saveConfig({
        protocol: protocol,
        baseUrl: element_url.value.trim(),
        apiKey: element_key.value.trim(),
        model: element_model.value.trim(),
        moveModel: element_moveModel.value.trim(),
        reasoningEffort: VALID_REASONING_EFFORTS.includes(effort) ? effort : '',
        autoAnalyze: element_auto.checked,
        autoCritique: element_autoCoach.checked,
    });
    if (!aicoach.isConfigured()) {
        setStatus(tr('needs_config', 'Enter your API URL, key and model, then press Save.'), true);
        return false;
    }
    return true;
}
function callback_ToggleSettings() {
    element_settings.classList.toggle('hidden');
}
function callback_Save() {
    if (!saveFormIntoConfig())
        return;
    setStatus(tr('saved', 'Settings saved.'), false);
    // The moment the config becomes usable is the moment the coach can introduce itself.
    void maybeStartCoachSession();
}
async function callback_Test() {
    if (!saveFormIntoConfig())
        return;
    setStatus(tr('testing', 'Testing connection...'), false, true);
    setBusy(true);
    try {
        const reply = await aicoach.testConnection();
        setStatus(`${tr('test_ok', 'Connection OK. Reply:')} ${reply}`, false);
    }
    catch (error) {
        setStatus(`${tr('test_failed', 'Connection failed:')} ${messageOf(error)}`, true);
    }
    finally {
        setBusy(false);
    }
}
function callback_AutoChanged() {
    aicoach.saveConfig({ autoAnalyze: element_auto.checked });
}
function callback_AutoCoachChanged() {
    aicoach.saveConfig({ autoCritique: element_autoCoach.checked });
    // Turning it back on shouldn't wait for the next move to say something.
    if (element_autoCoach.checked)
        lastCritiquedMoveCount = -1;
}
// Analyzing -------------------------------------------------------------
function callback_Analyze() {
    void analyze(false);
}
/**
 * Runs one analysis.
 * @param automatic - True when triggered by the auto-analyze poll, which keeps
 * failures quiet so a bad config doesn't spam the panel every move.
 */
async function analyze(automatic) {
    const gamefile = gameslot.getGamefile();
    if (gamefile === undefined)
        return;
    if (aicoach.isRequestInFlight())
        return;
    if (!aicoach.isConfigured()) {
        element_settings.classList.remove('hidden');
        setStatus(tr('needs_config', 'Enter your API URL, key and model, then press Save.'), true);
        return;
    }
    lastAnalyzedMoveCount = gamefile.moves.length;
    setStatus(tr('analyzing', 'Thinking...'), false, true);
    setBusy(true);
    try {
        const advice = await aicoach.requestAdvice(gamefile);
        renderAdvice(advice);
        frametracker.onVisualChange(); // The board highlight needs a redraw
    }
    catch (error) {
        const message = messageOf(error);
        setStatus(message, true);
        if (!automatic)
            statustext.showStatus(message, true);
    }
    finally {
        setBusy(false);
    }
}
function setBusy(busy) {
    element_analyze.disabled = busy;
    element_analyze.classList.toggle('opacity-0_5', busy);
}
// Auto-analyze -------------------------------------------------------------
/**
 * The panel polls instead of hooking the move logic, which keeps this feature
 * entirely self-contained — nothing in the move pipeline has to know it exists.
 * One timer covers both auto-analyze and the "AI, move" button's visibility.
 */
function startPollTimer() {
    if (autoAnalyzeIntervalID !== undefined)
        return;
    autoAnalyzeIntervalID = setInterval(poll, AUTO_ANALYZE_POLL_MILLIS);
    poll(); // Don't make the button wait 800ms to appear
}
function stopPollTimer() {
    if (autoAnalyzeIntervalID === undefined)
        return;
    clearInterval(autoAnalyzeIntervalID);
    autoAnalyzeIntervalID = undefined;
}
function poll() {
    if (!isOpen)
        return stopPollTimer();
    updateAIMoveButton();
    if (element_auto.checked)
        pollForNewPosition();
    if (element_autoCoach.checked)
        pollForCritique();
}
/**
 * The retry button only makes sense in an AI game where the AI owes us a move
 * and isn't already working on one — i.e. its last attempt failed.
 */
function updateAIMoveButton() {
    const gamefile = gameslot.getGamefile();
    const show = gamefile !== undefined
        && enginegame.areInAIOpponentGame()
        && !enginegame.isAIOpponentThinking()
        && !enginegame.isItOurTurn()
        && !gamefileutility.isGameOver(gamefile);
    element_aimove.classList.toggle('hidden', !show);
}
function pollForNewPosition() {
    const gamefile = gameslot.getGamefile();
    if (gamefile === undefined)
        return;
    if (gamefile.moves.length === lastAnalyzedMoveCount)
        return; // Nothing new
    if (gamefileutility.isGameOver(gamefile))
        return;
    // In an online game there's nothing to advise until it's our move.
    if (onlinegame.areInOnlineGame() && !onlinegame.isItOurTurn())
        return;
    // Same in an engine/AI game — don't coach the opponent's move.
    if (enginegame.areInEngineGame() && !enginegame.isItOurTurn())
        return;
    void analyze(true);
}
// The coach's unprompted commentary -------------------------------------------------------------
/**
 * Which side is the player's, when there is one.
 *
 * A local hotseat game doesn't have one — the same person plays both colours — so
 * `undefined` there means "every move is the player's move".
 */
function getOurColorOrUndefined() {
    try {
        if (onlinegame.areInOnlineGame())
            return onlinegame.getOurColor();
        if (enginegame.areInEngineGame())
            return enginegame.getOurColor();
    }
    catch {
        return undefined; // Asked after the game was torn down
    }
    return undefined;
}
/**
 * Decides whether the coach should say something about the player's play right now.
 *
 * Once per completed round, not once per half-move: the remark waits until the opponent
 * has answered, so the coach is commenting on a finished exchange and isn't racing the AI
 * opponent's own request through the same endpoint.
 */
function pollForCritique() {
    const gamefile = gameslot.getGamefile();
    if (gamefile === undefined)
        return;
    if (critiqueInFlight || askInFlight)
        return;
    if (aicoach.isRequestInFlight())
        return; // An analysis is using the endpoint
    if (!aicoach.isConfigured())
        return;
    const moveCount = gamefile.moves.length;
    // The game is finished: one closing review, then nothing more.
    if (gamefileutility.isGameOver(gamefile)) {
        if (finalReviewDone)
            return;
        if (moveCount === 0)
            return; // Aborted before anyone played
        finalReviewDone = true;
        lastCritiquedMoveCount = moveCount;
        void critique(true);
        return;
    }
    if (moveCount === 0)
        return; // Nobody has played yet
    if (moveCount === lastCritiquedMoveCount)
        return; // Already commented on this position
    const ourColor = getOurColorOrUndefined();
    // As black, move 1 is the opponent's and it's our turn straight after it. There's
    // nothing of ours to critique until move 2.
    if (ourColor === players.BLACK && moveCount < 2)
        return;
    // Wait for the opponent's reply before speaking.
    if (onlinegame.areInOnlineGame() && !onlinegame.isItOurTurn())
        return;
    if (enginegame.areInEngineGame()) {
        if (!enginegame.isItOurTurn())
            return;
        if (enginegame.isAIOpponentThinking())
            return;
    }
    lastCritiquedMoveCount = moveCount;
    void critique(false);
}
/**
 * Asks the coach for one remark and drops it into the chat.
 *
 * Failures land in the status line and nowhere else. This fires on its own every round,
 * so a bad endpoint would otherwise bury the transcript under identical error bubbles.
 * @param final - True for the end-of-game review rather than a mid-game remark
 */
async function critique(final) {
    critiqueInFlight = true;
    setStatus(final
        ? tr('reviewing', 'The coach is reviewing the game...')
        : tr('critiquing', 'The coach is looking at your position...'), false, true);
    try {
        const remark = await aicoach.requestCritique(gameslot.getGamefile(), final);
        appendBubble('ai', tr('chat_coach', 'Coach'), remark);
        setStatus('', false);
    }
    catch (error) {
        setStatus(`${tr('critique_failed', 'The coach could not comment:')} ${messageOf(error)}`, true);
    }
    finally {
        critiqueInFlight = false;
    }
}
// Helping out an idle player -------------------------------------------------------------
/**
 * The player has been sitting on their turn for a minute. Offer them a move.
 *
 * Called by `idlenudge`. The panel is opened if it was closed: advice delivered into a
 * hidden panel is no help, and the point of this is to unstick someone who is stuck.
 *
 * Reuses the normal analysis path, so the recommended move gets highlighted on the board
 * as well as written out. The chat line is there because that's where the player is
 * looking if the panel was already open.
 */
function onPlayerIdle() {
    void suggestForIdlePlayer();
}
async function suggestForIdlePlayer() {
    if (!aicoach.isConfigured())
        return; // Nothing to ask
    if (askInFlight || critiqueInFlight || aicoach.isRequestInFlight())
        return;
    if (!isOpen)
        open();
    appendSystemBubble(tr('idle_nudge', "You haven't moved in a while — the coach is taking a look."));
    await analyze(true);
    const advice = aicoach.getLatestAdvice();
    if (advice?.bestMove === undefined)
        return;
    const suggestion = `${tr('idle_suggestion', 'Try')} ${formatMove(advice.bestMove)}`;
    appendBubble('ai', tr('chat_coach', 'Coach'), advice.reasoning === '' ? suggestion : `${suggestion} — ${advice.reasoning}`);
}
// Playing against the AI -------------------------------------------------------------
function callback_AIMove() {
    enginegame.retryAIOpponentMove();
    updateAIMoveButton();
}
/**
 * "Moved in 6.2s" — and, when it took more than one upstream request, says so.
 *
 * Worth the panel space: a move that cost two upstream requests is a config problem
 * (the endpoint refused a parameter and we walked down to a plainer body), not a slow
 * model, and only the second one is fixed by picking a faster model. After the first
 * such move the server remembers the working shape, so the count should settle at 1.
 */
function describeMoveTiming(event) {
    if (event.elapsedMillis === undefined)
        return '';
    const seconds = (event.elapsedMillis / 1000).toFixed(1);
    const base = `${tr('moved_in', 'AI moved in')} ${seconds}s`;
    const requests = event.upstreamAttempts ?? 1;
    if (requests <= 1)
        return base;
    return `${base} — ${requests} ${tr('upstream_requests', 'upstream requests')}`;
}
/** Called by `enginegame` as the AI opponent's turn progresses. */
function onAIOpponentEvent(event) {
    switch (event.kind) {
        case 'thinking':
            setStatus(tr('ai_thinking', 'The AI is thinking about its move...'), false, true);
            break;
        case 'moved':
            setStatus(describeMoveTiming(event), false);
            if (event.wasRandom) {
                // `failure` says *why* we fell back. A hung endpoint and a model that cannot
                // follow the format both end here, and they need completely different fixes,
                // so the specific reason replaces the generic line whenever we have one.
                appendSystemBubble(event.failure ?? tr('ai_random_move', 'The AI could not produce a legal move, so a random legal move was played.'));
                if (event.failure !== undefined) {
                    appendSystemBubble(tr('ai_random_played', 'A random legal move was played so the game can continue.'));
                }
            }
            else if (event.comment !== undefined) {
                appendBubble('ai', tr('chat_ai', 'AI'), event.comment);
            }
            break;
        case 'error':
            setStatus(`${tr('ai_move_failed', 'The AI could not move:')} ${event.message}`, true);
            break;
    }
    updateAIMoveButton();
    frametracker.onVisualChange();
}
// The remembered skill level -------------------------------------------------------------
/**
 * Shows or hides the saved-level row.
 *
 * Called wherever the profile can have changed: on open, after the coach's opening
 * message, and after every answer — the verdict arrives inside an ordinary reply, so
 * there is no single moment to hook.
 */
function refreshProfile() {
    const profile = aicoach.getProfile();
    if (profile === undefined) {
        element_profile.classList.add('hidden');
        element_profileText.textContent = '';
        return;
    }
    const assessed = new Date(profile.assessedAt);
    const when = Number.isNaN(assessed.getTime()) ? '' : ` (${assessed.toLocaleDateString()})`;
    element_profileText.textContent = `${tr('profile_level', 'Level on record')}: ${profile.elo} Elo${when}`;
    element_profile.classList.remove('hidden');
}
/**
 * Throws the saved level away and starts the interview again.
 *
 * The chat goes with it: leaving the old transcript in place would put the coach's
 * previous verdict back into its own context, which is exactly the thing being reset.
 */
function callback_Reassess() {
    aicoach.clearProfile();
    aicoach.clearChat();
    element_chat.replaceChildren();
    refreshProfile();
    appendSystemBubble(tr('profile_cleared', 'Level forgotten. The coach will assess you again.'));
    void maybeStartCoachSession();
}
// The chat box -------------------------------------------------------------
/** Enter sends; Shift+Enter makes a new line. */
function callback_QuestionKeydown(event) {
    if (event.key !== 'Enter' || event.shiftKey)
        return;
    event.preventDefault();
    void ask();
}
function callback_Send() {
    void ask();
}
function callback_ClearChat() {
    aicoach.clearChat();
    element_chat.replaceChildren();
    // Clearing the chat restarts the session, so the coach re-introduces itself and
    // re-assesses rather than silently keeping the level it decided on before.
    void maybeStartCoachSession();
}
/**
 * Lets the coach open the conversation: an introduction, then its questions about how
 * strong the player is. Driven by the persona in `tsc.md`.
 *
 * Fires on panel open, on a successful Save, and after the chat is cleared. All three are
 * "the coach is starting now" moments, and `aicoach` makes the call idempotent, so none of
 * them has to know whether one of the others already did it.
 *
 * Failures are shown but never thrown: a coach that couldn't say hello is a coach you can
 * still type at.
 */
async function maybeStartCoachSession() {
    if (!aicoach.isConfigured())
        return;
    setStatus(tr('coach_starting', 'The coach is getting ready...'), false, true);
    try {
        const greeting = await aicoach.startCoachSession();
        if (greeting === undefined) {
            // Nothing to do — no persona file, or the session was already running.
            const failure = aicoach.getPersonaError();
            if (failure !== undefined)
                setStatus(`${tr('persona_failed', 'Could not read the coach prompt file (tsc.md):')} ${failure}`, true);
            else
                setStatus('', false);
            return;
        }
        appendBubble('ai', tr('chat_ai', 'AI'), greeting);
        setStatus('', false);
        refreshProfile();
    }
    catch (error) {
        setStatus(`${tr('coach_start_failed', 'The coach could not start:')} ${messageOf(error)}`, true);
    }
}
async function ask() {
    if (askInFlight)
        return;
    const question = element_question.value.trim();
    if (question === '')
        return;
    if (!aicoach.isConfigured()) {
        element_settings.classList.remove('hidden');
        setStatus(tr('needs_config', 'Enter your API URL, key and model, then press Save.'), true);
        return;
    }
    element_question.value = '';
    appendBubble('you', tr('chat_you', 'You'), question);
    setStatus(tr('asking', 'Asking the AI...'), false, true);
    askInFlight = true;
    element_send.disabled = true;
    try {
        const answer = await aicoach.askQuestion(gameslot.getGamefile(), question);
        appendBubble('ai', tr('chat_ai', 'AI'), answer);
        setStatus('', false);
        // This is usually the reply the coach's verdict lands in, so the row appears here.
        refreshProfile();
    }
    catch (error) {
        setStatus(messageOf(error), true);
    }
    finally {
        askInFlight = false;
        element_send.disabled = false;
    }
}
/** Rebuilds the transcript from `aicoach`'s history, e.g. after reopening the panel. */
function renderChat() {
    element_chat.replaceChildren();
    for (const message of aicoach.getChatHistory()) {
        if (message.hidden)
            continue; // The session kickoff. The player never wrote it.
        if (message.role === 'user')
            appendBubble('you', tr('chat_you', 'You'), message.content);
        else
            appendBubble('ai', tr('chat_ai', 'AI'), message.content);
    }
}
/** Model output goes in via textContent. Never as HTML. */
function appendBubble(who, author, text) {
    const bubble = document.createElement('div');
    bubble.classList.add('aicoach-bubble', who === 'you' ? 'aicoach-bubble-you' : 'aicoach-bubble-ai');
    const label = document.createElement('span');
    label.classList.add('aicoach-bubble-author');
    label.textContent = author;
    const body = document.createElement('span');
    body.textContent = text;
    bubble.append(label, body);
    element_chat.append(bubble);
    scrollChatToBottom();
}
/** A centered note from us, not from either player. */
function appendSystemBubble(text) {
    const bubble = document.createElement('div');
    bubble.classList.add('aicoach-bubble', 'aicoach-bubble-system');
    bubble.textContent = text;
    element_chat.append(bubble);
    scrollChatToBottom();
}
function scrollChatToBottom() {
    element_scroll.scrollTop = element_scroll.scrollHeight;
}
// Rendering the advice -------------------------------------------------------------
/**
 * `busy` adds the animated trailing dots, so a slow request looks like it's
 * working rather than like a frozen panel.
 */
function setStatus(text, isError, busy = false) {
    element_status.textContent = text;
    element_status.classList.toggle('aicoach-error', isError);
    element_status.classList.toggle('aicoach-busy', busy && !isError);
}
/** `[4,1] → [4,3]` */
function formatMove(move) {
    return `[${move.from[0]},${move.from[1]}] → [${move.to[0]},${move.to[1]}]`;
}
/** Builds a titled block. Text goes in via textContent — never trust model output as HTML. */
function section(title, body) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('aicoach-section');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = body;
    wrapper.append(heading, paragraph);
    return wrapper;
}
function listSection(title, items) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('aicoach-section');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('ul');
    for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        list.append(li);
    }
    wrapper.append(heading, list);
    return wrapper;
}
function renderAdvice(advice) {
    element_results.replaceChildren();
    // Nothing structured came back — show the raw reply so the user isn't left guessing.
    if (advice.assessment === '' && advice.bestMove === undefined && advice.reasoning === '') {
        const pre = document.createElement('pre');
        pre.classList.add('aicoach-raw');
        pre.textContent = advice.raw.slice(0, 4000);
        element_results.append(pre);
        setStatus(tr('unparsed', 'Could not read a structured answer out of the reply.'), true);
        return;
    }
    if (advice.assessment !== '')
        element_results.append(section(tr('assessment', 'Assessment'), advice.assessment));
    if (advice.threats.length > 0)
        element_results.append(listSection(tr('threats', 'Threats against you'), advice.threats));
    if (advice.bestMove !== undefined) {
        const block = section(tr('best_move', 'Recommended move'), formatMove(advice.bestMove));
        block.classList.add('aicoach-bestmove');
        element_results.append(block);
        if (advice.reasoning !== '')
            element_results.append(section(tr('reasoning', 'Why'), advice.reasoning));
    }
    else if (advice.reasoning !== '') {
        element_results.append(section(tr('reasoning', 'Why'), advice.reasoning));
    }
    if (advice.alternatives.length > 0) {
        const items = advice.alternatives.map((move) => (move.note === undefined ? formatMove(move) : `${formatMove(move)} — ${move.note}`));
        element_results.append(listSection(tr('alternatives', 'Alternatives'), items));
    }
    if (advice.rejectedMove !== undefined) {
        const warning = section(tr('illegal_title', 'Suggested move was illegal'), `${advice.rejectedMove}\n${tr('illegal_body', 'The model could not produce a legal move, so nothing is highlighted. The written analysis may still be useful.')}`);
        warning.classList.add('aicoach-warning');
        element_results.append(warning);
    }
    if (advice.bestMove !== undefined)
        setStatus(`${tr('done', 'Recommended:')} ${formatMove(advice.bestMove)}`, false);
    else
        setStatus(tr('done_no_move', 'Analysis complete, no move recommended.'), false);
}
// Helpers -------------------------------------------------------------
/** Looks up `[play.javascript.aicoach]` from the injected translations. */
function tr(key, fallback) {
    if (typeof translations === 'undefined')
        return fallback;
    const group = translations['aicoach'];
    const value = group === undefined || group === null ? undefined : group[key];
    return typeof value === 'string' && value !== '' ? value : fallback;
}
function messageOf(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
export default {
    areOpen,
    open,
    openSettings,
    close,
    toggle,
    reset,
    onNewGame,
    onPlayerIdle,
};
