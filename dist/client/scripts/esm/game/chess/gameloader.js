/**
 * This script contains the logic for loading any kind of game onto our game board:
 * * Local
 * * Online
 * * Analysis Board (in the future)
 * * Board Editor (in the future)
 *
 * It not only handles the logic of the gamefile,
 * but also prepares and opens the UI elements for that type of game.
 */
import gui from "../gui/gui.js";
import gameslot from "./gameslot.js";
import timeutil from "../../util/timeutil.js";
import gamefileutility from "../../chess/util/gamefileutility.js";
import enginegame from "../misc/enginegame.js";
import loadingscreen from "../gui/loadingscreen.js";
import { players } from "../../chess/util/typeutil.js";
// @ts-ignore
import guigameinfo from "../gui/guigameinfo.js";
// @ts-ignore
import guinavigation from "../gui/guinavigation.js";
// @ts-ignore
import onlinegame from "../misc/onlinegame/onlinegame.js";
// @ts-ignore
import localstorage from "../../util/localstorage.js";
// @ts-ignore
import perspective from "../rendering/perspective.js";
// @ts-ignore
import transition from "../rendering/transition.js";
import boardpos from "../rendering/boardpos.js";
/**
 * How the game currently on the board was started, so that the game-over screen's
 * "Play again" button can start an identical one without walking back through the menus.
 * Online games are not replayable — a rematch there needs a second consenting human.
 */
let lastGameOptions;
/** The type of game we are in, whether local or online, if we are in a game. */
let typeOfGameWeAreIn;
/**
 * True when the gamefile is currently loading either the graphical
 * (such as the SVG requests and spritesheet generation) or engine script.
 *
 * If so, the spinny pawn loading animation will be open.
 */
let gameLoading = false;
// Getters --------------------------------------------------------------------
/**
 * Returns true if we are in ANY type of game, whether local, online, engine, analysis, or editor.
 *
 * If we're on the title screen or the lobby, this will be false.
 */
function areInAGame() {
    return typeOfGameWeAreIn !== undefined;
}
/** Returns the type of game we are in. */
function getTypeOfGameWeIn() {
    return typeOfGameWeAreIn;
}
function areInLocalGame() {
    return typeOfGameWeAreIn === 'local';
}
function isItOurTurn(color) {
    if (typeOfGameWeAreIn === undefined)
        throw Error("Can't tell if it's our turn when we're not in a game!");
    if (typeOfGameWeAreIn === 'online')
        return onlinegame.isItOurTurn();
    else if (typeOfGameWeAreIn === 'engine')
        return enginegame.isItOurTurn();
    else if (typeOfGameWeAreIn === 'local')
        return gameslot.getGamefile().whosTurn === color;
    else
        throw Error("Don't know how to tell if it's our turn in this type of game: " + typeOfGameWeAreIn);
}
function getOurColor() {
    if (typeOfGameWeAreIn === undefined)
        throw Error("Can't get our color when we're not in a game!");
    if (typeOfGameWeAreIn === 'online')
        return onlinegame.getOurColor();
    else if (typeOfGameWeAreIn === 'engine')
        return enginegame.getOurColor();
    throw Error("Can't get our color in this type of game: " + typeOfGameWeAreIn);
}
/**
 * Returns true if either the graphics (spritesheet generating),
 * or engine script, of the gamefile are currently being loaded.
 *
 * If so, the spinny pawn loading animation will be open.
 */
function areWeLoadingGame() {
    return gameLoading;
}
/**
 * Updates whatever game is currently loaded, for what needs to be updated.
 */
function update() {
    if (typeOfGameWeAreIn === 'online')
        onlinegame.update();
}
/** Whether there's a game we know how to start over again ("Play again"). */
function canReplayLastGame() {
    return lastGameOptions !== undefined;
}
/** Whether the last started game was against the LLM, which owns the chat panel. */
function wasLastGameVsLLM() {
    if (lastGameOptions === undefined || lastGameOptions.kind !== 'engine')
        return false;
    return lastGameOptions.options.currentEngine === 'aiOpponent';
}
/**
 * Unloads the current game and immediately starts another one with identical options.
 * Used by the game-over screen's "Play again" button.
 */
async function replayLastGame() {
    const last = lastGameOptions;
    if (last === undefined)
        return;
    unloadGame(); // A new gamefile can't be loaded on top of the old one
    if (last.kind === 'local')
        await startLocalGame(last.options);
    else
        await startEngineGame(last.options);
}
// Start Game --------------------------------------------------------------------
/** Starts a local game according to the options provided. */
async function startLocalGame(options) {
    typeOfGameWeAreIn = 'local';
    lastGameOptions = { kind: 'local', options };
    gameLoading = true;
    // Has to be awaited to give the document a chance to repaint.
    await loadingscreen.open();
    const metadata = {
        ...options,
        Event: `Casual local ${translations[options.Variant]} infinite chess game`,
        Site: 'https://www.infinitechess.org/',
        Round: '-',
        UTCDate: timeutil.getCurrentUTCDate(),
        UTCTime: timeutil.getCurrentUTCTime()
    };
    gameslot.loadGamefile({
        metadata,
        viewWhitePerspective: true,
        allowEditCoords: true,
        /**
         * Enable to tell the gamefile to include large amounts of undefined slots for every single piece type in the game.
         * This lets us board edit without worry of regenerating the mesh every time we add a piece.
         */
        // additional: { editor: true }
    })
        .then((result) => onFinishedLoading())
        .catch((err) => onCatchLoadingError(err));
    // Open the gui stuff AFTER initiating the logical stuff,
    // because the gui DEPENDS on the other stuff.
    openGameinfoBarAndConcludeGameIfOver(metadata, false);
}
/** Starts an online game according to the options provided by the server. */
async function startOnlineGame(options) {
    // console.log("Starting online game with invite options:");
    // console.log(jsutil.deepCopyObject(options));
    typeOfGameWeAreIn = 'online';
    lastGameOptions = undefined; // A rematch would need the other human to agree, so there's nothing to replay.
    gameLoading = true;
    // Has to be awaited to give the document a chance to repaint.
    await loadingscreen.open();
    const additional = {
        moves: options.moves,
        variantOptions: localstorage.loadItem(options.id),
        gameConclusion: options.gameConclusion,
        // If the clock values are provided, adjust the timer of whos turn it is depending on ping.
        clockValues: options.clockValues,
    };
    gameslot.loadGamefile({
        metadata: options.metadata,
        viewWhitePerspective: options.youAreColor === players.WHITE,
        allowEditCoords: false,
        additional
    })
        .then((result) => onFinishedLoading())
        .catch((err) => onCatchLoadingError(err));
    onlinegame.initOnlineGame(options);
    // Open the gui stuff AFTER initiating the logical stuff,
    // because the gui DEPENDS on the other stuff.
    openGameinfoBarAndConcludeGameIfOver(options.metadata, false);
}
/** Starts an engine game according to the options provided. */
async function startEngineGame(options) {
    if (options.Variant && options.variantOptions)
        throw Error("Can't provide both Variant and variantOptions at the same time when starting an engine game. They are mutually exclusive.");
    if (!options.Variant && !options.variantOptions)
        throw Error("Must provide either Variant or variantOptions when starting an engine game.");
    typeOfGameWeAreIn = 'engine';
    lastGameOptions = { kind: 'engine', options };
    gameLoading = true;
    // Has to be awaited to give the document a chance to repaint.
    await loadingscreen.open();
    const opponentName = options.opponentName ?? 'Engine';
    const metadata = {
        Event: options.Event,
        Site: 'https://www.infinitechess.org/',
        Round: '-',
        TimeControl: '-',
        White: options.youAreColor === players.WHITE ? '(You)' : opponentName,
        Black: options.youAreColor === players.BLACK ? '(You)' : opponentName,
        UTCDate: timeutil.getCurrentUTCDate(),
        UTCTime: timeutil.getCurrentUTCTime()
    };
    if (options.Variant)
        metadata.Variant = options.Variant;
    /** A promise that resolves when the GRAPHICAL (spritesheet) part of the game has finished loading. */
    const graphicalPromise = gameslot.loadGamefile({
        metadata,
        viewWhitePerspective: options.youAreColor === players.WHITE,
        allowEditCoords: false,
        additional: { variantOptions: options.variantOptions }
    });
    /** A promise that resolves when the engine script has been fetched. */
    const enginePromise = enginegame.initEngineGame(options)
        .then(() => enginegame.onMovePlayed()); // Without this, the engine won't start calculating moves if it's first to move.
    /**
     * This resolves when BOTH the graphical and engine promises resolve,
     * OR rejects immediately when one of them rejects!
     */
    Promise.all([graphicalPromise, enginePromise])
        .then((results) => onFinishedLoading())
        .catch((err) => onCatchLoadingError(err));
    openGameinfoBarAndConcludeGameIfOver(metadata, options.showGameControlButtons);
}
/**
 * Reloads the current local, online, or editor game from the provided metadata, existing moves, and variant options.
 */
async function pasteGame(options) {
    if (typeOfGameWeAreIn !== 'local' && typeOfGameWeAreIn !== 'online' && typeOfGameWeAreIn !== 'editor')
        throw Error("Can't paste a game when we're not in a local, online, or editor game.");
    if (typeOfGameWeAreIn === 'editor' && options.additional.moves && options.additional.moves.length > 0)
        throw Error("Can't paste a game with moves played while in the editor.");
    gameLoading = true;
    // Has to be awaited to give the document a chance to repaint.
    await loadingscreen.open();
    const viewWhitePerspective = gameslot.isLoadedGameViewingWhitePerspective(); // Retain the same perspective as the current loaded game.
    const additionalToUse = {
        ...options.additional,
        editor: gameslot.getGamefile().editor, // Retain the same option as the current loaded game.
    };
    gameslot.unloadGame();
    gameslot.loadGamefile({
        metadata: options.metadata,
        viewWhitePerspective,
        allowEditCoords: guinavigation.areCoordsAllowedToBeEdited(),
        additional: additionalToUse,
    })
        .then((result) => onFinishedLoading())
        .catch((err) => onCatchLoadingError(err));
    // Open the gui stuff AFTER initiating the logical stuff,
    // because the gui DEPENDS on the other stuff.
    openGameinfoBarAndConcludeGameIfOver(options.metadata, false);
}
/**
 * A function that is executed when a game is FULLY loaded (graphical, spritesheet, engine, etc.)
 * This hides the spinny pawn loading animation that covers the board.
 */
function onFinishedLoading() {
    // console.log('COMPLETELY finished loading game!');
    gameLoading = false;
    // We can now close the loading screen.
    // I don't think this one has to be awaited since we're pretty much
    // done with loading, there's not gonna be another lag spike..
    loadingscreen.close();
    gameslot.startStartingTransition(); // Play the zoom-in animation at the start of games.
}
/**
 * Replaces the loading animation with the words
 * "ERROR. One or more resources failed to load. Please refresh."
 */
function onCatchLoadingError(err) {
    console.error(err);
    loadingscreen.onError();
}
/**
 * These items must be done after the logical parts of the gamefile are fully loaded
 * @param metadata - The metadata of the gamefile
 * @param showGameControlButtons - Whether to show the practice game control buttons "Undo Move" and "Retry"
 */
function openGameinfoBarAndConcludeGameIfOver(metadata, showGameControlButtons = false) {
    guigameinfo.open(metadata, showGameControlButtons);
    if (gamefileutility.isGameOver(gameslot.getGamefile()))
        gameslot.concludeGame();
}
function unloadGame() {
    if (typeOfGameWeAreIn === 'online')
        onlinegame.closeOnlineGame();
    else if (typeOfGameWeAreIn === 'engine')
        enginegame.closeEngineGame();
    guinavigation.close();
    guigameinfo.close();
    gameslot.unloadGame();
    perspective.disable();
    typeOfGameWeAreIn = undefined;
    boardpos.eraseMomentum();
    transition.terminate();
    gui.prepareForOpen();
}
// Exports --------------------------------------------------------------------
export default {
    areInAGame,
    areInLocalGame,
    isItOurTurn,
    getOurColor,
    areWeLoadingGame,
    getTypeOfGameWeIn,
    update,
    canReplayLastGame,
    wasLastGameVsLLM,
    replayLastGame,
    startLocalGame,
    startOnlineGame,
    startEngineGame,
    pasteGame,
    openGameinfoBarAndConcludeGameIfOver,
    unloadGame,
};
