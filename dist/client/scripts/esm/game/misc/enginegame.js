// This module keeps track of the data of the engine game we are currently in.
import selection from '../chess/selection.js';
import checkmatepractice from '../chess/checkmatepractice.js';
import gameslot from '../chess/gameslot.js';
import movesequence from '../chess/movesequence.js';
import gamecompressor from '../chess/gamecompressor.js';
import jsutil from '../../util/jsutil.js';
// @ts-ignore
import perspective from '../rendering/perspective.js';
import typeutil from '../../chess/util/typeutil.js';
import aicoach from './aicoach.js';
// Variables --------------------------------------------------------------------
/**
 * The pseudo-engine name for "play against the configured LLM".
 *
 * It isn't a real web worker — there's no file at `engines/aiOpponent.js`. The LLM
 * lives behind a network request, so its turn runs on the main thread instead.
 */
const AI_OPPONENT_ENGINE = 'aiOpponent';
/** Whether we are currently in an engine game. */
let inEngineGame = false;
let ourColor;
let engineColor;
let currentEngine; // name of the current engine used
let engineConfig; // json that is sent to the engine, giving it extra config information
let engineWorker;
/** True while we're waiting on the LLM. Stops a second turn from being started. */
let aiThinking = false;
/**
 * Set by `guiaicoach`, so the panel can show "thinking..." without this module
 * importing it. The dependency only ever points one way: gui -> enginegame.
 */
let aiListener;
// Functions ------------------------------------------------------------------------
function areInEngineGame() {
    return inEngineGame;
}
function getOurColor() {
    if (!inEngineGame)
        throw Error("Cannot get our color if we are not in an engine game!");
    return ourColor;
}
function isItOurTurn() {
    if (!inEngineGame)
        throw Error("Cannot get isItOurTurn of engine game when we're not in an engine game.");
    return gameslot.getGamefile().whosTurn === ourColor;
}
function getCurrentEngine() {
    return currentEngine;
}
/**
 * Inits an engine game. In particular, it needs gameOptions in order to know what engine to use for this enginegame.
 * This method launches an engine webworker for the current game.
 * @param {Object} options - An object that contains the properties `currentEngine` and `engineConfig`
 */
function initEngineGame(options) {
    console.log(`Starting engine game with engine "${options.currentEngine}".`);
    inEngineGame = true;
    ourColor = options.youAreColor;
    engineColor = typeutil.invertPlayer(ourColor);
    currentEngine = options.currentEngine;
    engineConfig = options.engineConfig;
    // The LLM opponent has no worker file — its "engine" is an HTTP request.
    if (currentEngine === AI_OPPONENT_ENGINE) {
        aiThinking = false;
        return Promise.resolve();
    }
    // Initialize the engine as a webworker
    if (!window.Worker) {
        alert("Your browser doesn't support web workers. Cannot play against an engine.");
        // Reject the promise returned by this function
        return Promise.reject(new Error("Cannot finish loading engine game because web workers aren't supported."));
    }
    engineWorker = new Worker(`../scripts/esm/game/chess/engines/${currentEngine}.js`, { type: 'module' }); // module type allows the web worker to import methods and types from other scripts.
    // Return a promise that resolves when the ENGINE WORKER has finished fetching/loading.
    return new Promise((resolve, reject) => {
        // Set up a handler for the 'isready' command that indicates the worker is loaded and ready
        // We have to manually send this message at the top of our engines.
        engineWorker.onmessage = (e) => {
            if (e.data === 'readyok')
                resolve(); // Engine is ready!
        };
        engineWorker.onerror = (e) => {
            reject(new Error("Worker failed to load: " + e.message));
        };
    }).then((result) => {
        // After the promise resolves, we know the worker is ready
        // Overwrite the onmessage listener to listen for move submissions
        engineWorker.onmessage = (e) => makeEngineMove(e.data);
        // Remove the error handler (no longer needed after worker is ready)
        engineWorker.onerror = null;
    });
}
// Call when we leave an engine game
function closeEngineGame() {
    inEngineGame = false;
    ourColor = undefined;
    engineColor = undefined;
    currentEngine = undefined;
    engineConfig = undefined;
    aiThinking = false;
    perspective.resetRotations(); // Without this, leaving an engine game of which we were black, won't reset our rotation.
    // terminate the webworker
    if (engineWorker)
        engineWorker.terminate();
    engineWorker = undefined;
    checkmatepractice.onGameUnload();
}
/**
 * Tests if we are this color in the engine game.
 * @param color - p.WHITE / p.BLACK
 * @returns *true* if we are that color.
 */
function areWeColor(color) {
    return color === ourColor;
}
/**
 * This method is called externally when the player submits his move in an engine game
 * It submits the gamefile to the webworker
 */
async function onMovePlayed() {
    if (!inEngineGame)
        return; // Don't do anything if it's not an engine game
    const gamefile = gameslot.getGamefile();
    // Make sure it's the engine's turn
    if (gamefile.whosTurn !== engineColor)
        return; // Don't do anything if it's our turn (not the engines)
    checkmatepractice.registerHumanMove(); // inform the checkmatepractice script that the human player has made a move
    if (gamefile.gameConclusion)
        return; // Don't do anything if the game is over
    // The LLM opponent doesn't run in a worker, so it gets its own path.
    if (currentEngine === AI_OPPONENT_ENGINE)
        return await runAIOpponentTurn(gamefile);
    const abridgedGame = gamecompressor.compressGamefile(gamefile); // Compress the gamefile to send to the engine in a simpler json format
    // Send the gamefile to the engine web worker
    /** This has all nested functions removed. */
    const stringGamefile = JSON.stringify(gamefile, jsutil.stringifyReplacer);
    if (engineWorker)
        engineWorker.postMessage({ stringGamefile, lf: abridgedGame, engineConfig: engineConfig, youAreColor: engineColor });
    else
        console.error("User made a move in an engine game but no engine webworker is loaded!");
}
/**
 * Plays one turn for the LLM opponent.
 *
 * The request takes seconds, not milliseconds, so everything we checked before
 * awaiting has to be re-checked afterwards: the user may have resigned, gone back
 * to the menu, or started a new game while the model was thinking.
 */
async function runAIOpponentTurn(gamefile) {
    if (aiThinking)
        return; // Already on it
    aiThinking = true;
    aiListener?.({ kind: 'thinking' });
    try {
        const result = await aicoach.requestOpponentMove(gamefile);
        // Is this still the same game, and still the AI's move?
        if (!inEngineGame || currentEngine !== AI_OPPONENT_ENGINE)
            return;
        if (gameslot.getGamefile() !== gamefile)
            return;
        if (gamefile.whosTurn !== engineColor || gamefile.gameConclusion)
            return;
        if (result === undefined)
            return; // No legal moves; the conclusion check will catch it
        makeEngineMove(result.draft);
        aiListener?.({
            kind: 'moved',
            ...(result.meta.comment !== undefined ? { comment: result.meta.comment } : {}),
            wasRandom: result.meta.wasRandom,
            ...(result.meta.failure !== undefined ? { failure: result.meta.failure } : {}),
            ...(result.meta.elapsedMillis !== undefined ? { elapsedMillis: result.meta.elapsedMillis } : {}),
            ...(result.meta.upstreamAttempts !== undefined ? { upstreamAttempts: result.meta.upstreamAttempts } : {}),
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`AI opponent could not move: ${message}`);
        aiListener?.({ kind: 'error', message });
    }
    finally {
        aiThinking = false;
    }
}
/** True while the LLM opponent is waiting on its endpoint. */
function isAIOpponentThinking() {
    return aiThinking;
}
/** True when this game's opponent is the configured LLM. */
function areInAIOpponentGame() {
    return inEngineGame && currentEngine === AI_OPPONENT_ENGINE;
}
/**
 * Asks the AI to move again. For the panel's retry button, after its endpoint
 * failed and the game was left waiting on it.
 */
function retryAIOpponentMove() {
    if (!areInAIOpponentGame() || aiThinking)
        return;
    const gamefile = gameslot.getGamefile();
    if (gamefile === undefined)
        return;
    if (gamefile.whosTurn !== engineColor || gamefile.gameConclusion)
        return;
    void runAIOpponentTurn(gamefile);
}
function setAIOpponentListener(listener) {
    aiListener = listener;
}
/**
 * This method takes care of all the logic involved in making an engine move
 * It gets called after the engine finishes its calculation
 */
function makeEngineMove(moveDraft) {
    if (!inEngineGame)
        return;
    if (!currentEngine)
        return console.error("Attempting to make engine move, but no engine loaded!");
    const gamefile = gameslot.getGamefile();
    // Go to latest move before making a new move
    movesequence.viewFront(gamefile);
    /**
     * PERHAPS we don't need this stuff? It's just to find and apply any special move flag
     * that should go with the move. But shouldn't the engine provide that info with its move?
     */
    // const piecemoved = gamefileutility.getPieceAtCoords(gamefile, move.startCoords)!;
    // const legalMoves = legalmoves.calculate(gamefile, piecemoved);
    // const endCoordsToAppendSpecial: CoordsSpecial = jsutil.deepCopyObject(move.endCoords);
    // legalmoves.checkIfMoveLegal(legalMoves, move.startCoords, endCoordsToAppendSpecial); // Passes on any special moves flags to the endCoords
    const move = movesequence.makeMove(gamefile, moveDraft);
    if (gamefile.mesh.offset)
        movesequence.animateMove(move, true, true); // ONLY ANIMATE if the mesh has been generated. This may happen if the engine moves extremely fast on turn 1.
    selection.reselectPiece(); // Reselect the currently selected piece. Recalc its moves and recolor it if needed.
    checkmatepractice.registerEngineMove(); // inform the checkmatepractice script that the engine has made a move
}
function onGameConclude() {
    if (!inEngineGame)
        return;
    checkmatepractice.onEngineGameConclude();
}
// Export ---------------------------------------------------------------------------------
export default {
    AI_OPPONENT_ENGINE,
    areInEngineGame,
    getOurColor,
    isItOurTurn,
    getCurrentEngine,
    initEngineGame,
    closeEngineGame,
    areWeColor,
    onMovePlayed,
    onGameConclude,
    areInAIOpponentGame,
    isAIOpponentThinking,
    retryAIOpponentMove,
    setAIOpponentListener,
};
