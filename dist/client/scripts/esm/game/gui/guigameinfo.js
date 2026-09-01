/**
 * This script handles the game info bar, during a game,
 * displaying the clocks, and whos turn it currently is.
 */
// @ts-ignore
import onlinegame from '../misc/onlinegame/onlinegame.js';
// @ts-ignore
import winconutil from '../../chess/util/winconutil.js';
import frametracker from '../rendering/frametracker.js';
import gamefileutility from '../../chess/util/gamefileutility.js';
import gameslot from '../chess/gameslot.js';
import gameloader from '../chess/gameloader.js';
import enginegame from '../misc/enginegame.js';
import { players } from '../../chess/util/typeutil.js';
"use strict";
// Variables
const element_gameInfoBar = document.getElementById('game-info-bar');
const element_whosturn = document.getElementById('whosturn');
const element_dot = document.getElementById('dot');
const element_playerWhite = document.getElementById('playerwhite');
const element_playerBlack = document.getElementById('playerblack');
const element_practiceButtons = document.querySelector('.practice-engine-buttons');
const element_undoButton = document.getElementById('undobutton');
const element_restartButton = document.getElementById('restartbutton');
let isOpen = false;
/** Whether to show the practice mode game control buttons - undo move and restart. */
let showButtons = false;
// Functions
/**
 *
 * @param metadata - The metadata of the gamefile, with its respective White and Black player names
 * @param {boolean} showGameControlButtons
 */
function open(metadata, showGameControlButtons) {
    if (showGameControlButtons)
        showButtons = showGameControlButtons;
    else
        showButtons = false;
    const { white, black } = getPlayerNamesForGame(metadata);
    element_playerWhite.textContent = white;
    element_playerBlack.textContent = black;
    updateWhosTurn();
    element_gameInfoBar.classList.remove('hidden');
    if (showButtons) {
        element_practiceButtons.classList.remove('hidden');
        initListeners_Gamecontrol();
    }
    else
        element_practiceButtons.classList.add('hidden');
    isOpen = true;
}
function close() {
    // Restore the player names to original content
    element_playerWhite.textContent = '';
    element_playerBlack.textContent = '';
    // revealPlayerNames();
    // Restore the whosturn marker to original content
    element_whosturn.textContent = '';
    element_dot.classList.remove('dotblack');
    element_dot.classList.add('dotwhite');
    element_dot.classList.remove('hidden');
    // Hide the whole bar
    element_gameInfoBar.classList.add('hidden');
    // Close button listeners
    closeListeners_Gamecontrol();
    element_practiceButtons.classList.add('hidden');
    isOpen = false;
}
function initListeners_Gamecontrol() {
    element_undoButton.addEventListener('click', undoMove);
    element_restartButton.addEventListener('click', restartGame);
    // For some reason we need this in order to stop the undo button from getting focused when clicked??
    element_undoButton.addEventListener('mousedown', preventFocus);
}
function closeListeners_Gamecontrol() {
    element_undoButton.removeEventListener('click', undoMove);
    element_restartButton.removeEventListener('click', restartGame);
    element_undoButton.removeEventListener('mousedown', preventFocus);
}
function undoMove() {
    const event = new Event("guigameinfo-undoMove");
    document.dispatchEvent(event);
}
function restartGame() {
    const event = new Event("guigameinfo-restart");
    document.dispatchEvent(event);
}
/**
 * Disables / Enables the "Undo Move" button
 */
function update_GameControlButtons(undoingIsLegal) {
    if (undoingIsLegal) {
        element_undoButton.classList.remove('opacity-0_5');
        element_undoButton.style.cursor = "pointer";
        element_undoButton.disabled = false;
    }
    else {
        element_undoButton.classList.add('opacity-0_5');
        element_undoButton.style.cursor = "not-allowed";
        element_undoButton.disabled = true; // Disables the 'click' event from firing when it is pressed
    }
}
function preventFocus(event) {
    event.preventDefault();
}
/** Reveales the player names. Typically called after the draw offer UI is closed */
function revealPlayerNames() {
    element_playerWhite.classList.remove('hidden');
    element_playerBlack.classList.remove('hidden');
}
/** Hides the player names. Typically to make room for the draw offer UI */
function hidePlayerNames() {
    element_playerWhite.classList.add('hidden');
    element_playerBlack.classList.add('hidden');
}
function toggle() {
    if (isOpen)
        close();
    else
        open(gameslot.getGamefile().metadata, showButtons);
    // Flag next frame to be rendered, since the arrows indicators may change locations with the bars toggled.
    frametracker.onVisualChange();
}
function getPlayerNamesForGame(metadata) {
    if (gameloader.getTypeOfGameWeIn() === 'local') {
        return {
            white: translations['player_name_white_generic'],
            black: translations['player_name_black_generic']
        };
    }
    else if (onlinegame.areInOnlineGame()) {
        if (metadata.White === undefined || metadata.Black === undefined)
            throw Error('White or Black metadata not defined when getting player names for online game.');
        // If you are a guest, then we want your name to be "(You)" instead of "(Guest)"
        return {
            white: onlinegame.areWeColorInOnlineGame(players.WHITE) && metadata['White'] === translations['guest_indicator'] ? translations['you_indicator'] : metadata['White'],
            black: onlinegame.areWeColorInOnlineGame(players.BLACK) && metadata['Black'] === translations['guest_indicator'] ? translations['you_indicator'] : metadata['Black']
        };
    }
    else if (enginegame.areInEngineGame()) {
        return {
            white: metadata.White,
            black: metadata.Black
        };
    }
    else
        throw Error('Cannot get player names for game when not in a local, online, or engine game.');
}
/**
 * Updates the text at the bottom of the screen displaying who's turn it is now.
 * Call this after flipping the gamefile's `whosTurn` property.
 */
function updateWhosTurn() {
    const gamefile = gameslot.getGamefile();
    // In the scenario we forward the game to front after the game has adjudicated,
    // don't modify the game over text saying who won!
    if (gamefileutility.isGameOver(gamefile))
        return gameEnd(gamefile.gameConclusion);
    const color = gamefile.whosTurn;
    if (color !== players.WHITE && color !== players.BLACK)
        throw Error(`Cannot set the document element text showing whos turn it is when color is neither white nor black! ${color}`);
    let textContent = "";
    if (!gameloader.areInLocalGame()) {
        const ourTurn = gameloader.isItOurTurn();
        textContent = ourTurn ? translations['your_move'] : translations['their_move'];
    }
    else
        textContent = color === players.WHITE ? translations['white_to_move'] : translations['black_to_move'];
    element_whosturn.textContent = textContent;
    element_dot.classList.remove('hidden');
    if (color === players.WHITE) {
        element_dot.classList.remove('dotblack');
        element_dot.classList.add('dotwhite');
    }
    else {
        element_dot.classList.remove('dotwhite');
        element_dot.classList.add('dotblack');
    }
}
/** Updates the whosTurn text to say who won! */
function gameEnd(conclusion) {
    if (conclusion === false)
        throw Error("Should not call gameEnd when game isn't over.");
    element_dot.classList.add('hidden');
    element_whosturn.textContent = getResultText(conclusion);
}
/**
 * The one-sentence description of how the game ended, e.g. "You won by checkmate".
 * The game-over screen shows the same sentence, which is why this isn't inlined into `gameEnd`.
 */
function getResultText(conclusion) {
    // '1 checkmate' / '2 resignation' / '0 stalemate'  time/resignation/stalemate/repetition/checkmate/disconnect/agreement
    const { victor, condition } = winconutil.getVictorAndConditionFromGameConclusion(conclusion);
    const resultTranslations = translations['results'];
    const gamefile = gameslot.getGamefile();
    /** "Draw by the N-move rule", which has the move count spliced into the middle of it. */
    const drawMoveRule = () => `${resultTranslations.draw_moverule[0]}${(gamefile.gameRules.moveRule / 2)}${resultTranslations.draw_moverule[1]}`;
    if (onlinegame.areInOnlineGame()) {
        if (victor !== undefined && onlinegame.getOurColor() === victor)
            return condition === 'checkmate' ? resultTranslations.you_checkmate
                : condition === 'time' ? resultTranslations.you_time
                    : condition === 'resignation' ? resultTranslations.you_resignation
                        : condition === 'disconnect' ? resultTranslations.you_disconnect
                            : condition === 'royalcapture' ? resultTranslations.you_royalcapture
                                : condition === 'allroyalscaptured' ? resultTranslations.you_allroyalscaptured
                                    : condition === 'allpiecescaptured' ? resultTranslations.you_allpiecescaptured
                                        : condition === 'threecheck' ? resultTranslations.you_threecheck
                                            : condition === 'koth' ? resultTranslations.you_koth
                                                : resultTranslations.you_generic;
        else if (victor === players.NEUTRAL)
            return condition === 'stalemate' ? resultTranslations.draw_stalemate
                : condition === 'repetition' ? resultTranslations.draw_repetition
                    : condition === 'moverule' ? drawMoveRule()
                        : condition === 'insuffmat' ? resultTranslations.draw_insuffmat
                            : condition === 'agreement' ? resultTranslations.draw_agreement
                                : resultTranslations.draw_generic;
        else if (condition === 'aborted')
            return resultTranslations.aborted;
        else /* loss */
            return condition === 'checkmate' ? resultTranslations.opponent_checkmate
                : condition === 'time' ? resultTranslations.opponent_time
                    : condition === 'resignation' ? resultTranslations.opponent_resignation
                        : condition === 'disconnect' ? resultTranslations.opponent_disconnect
                            : condition === 'royalcapture' ? resultTranslations.opponent_royalcapture
                                : condition === 'allroyalscaptured' ? resultTranslations.opponent_allroyalscaptured
                                    : condition === 'allpiecescaptured' ? resultTranslations.opponent_allpiecescaptured
                                        : condition === 'threecheck' ? resultTranslations.opponent_threecheck
                                            : condition === 'koth' ? resultTranslations.opponent_koth
                                                : resultTranslations.opponent_generic;
    }
    // Local, engine or AI game — name the winning side instead of "you".
    if (condition === 'checkmate')
        return victor === players.WHITE ? resultTranslations.white_checkmate
            : victor === players.BLACK ? resultTranslations.black_checkmate
                : resultTranslations.bug_checkmate;
    else if (condition === 'time')
        return victor === players.WHITE ? resultTranslations.white_time
            : victor === players.BLACK ? resultTranslations.black_time
                : resultTranslations.bug_time;
    else if (condition === 'royalcapture')
        return victor === players.WHITE ? resultTranslations.white_royalcapture
            : victor === players.BLACK ? resultTranslations.black_royalcapture
                : resultTranslations.bug_royalcapture;
    else if (condition === 'allroyalscaptured')
        return victor === players.WHITE ? resultTranslations.white_allroyalscaptured
            : victor === players.BLACK ? resultTranslations.black_allroyalscaptured
                : resultTranslations.bug_allroyalscaptured;
    else if (condition === 'allpiecescaptured')
        return victor === players.WHITE ? resultTranslations.white_allpiecescaptured
            : victor === players.BLACK ? resultTranslations.black_allpiecescaptured
                : resultTranslations.bug_allpiecescaptured;
    else if (condition === 'threecheck')
        return victor === players.WHITE ? resultTranslations.white_threecheck
            : victor === players.BLACK ? resultTranslations.black_threecheck
                : resultTranslations.bug_threecheck;
    else if (condition === 'koth')
        return victor === players.WHITE ? resultTranslations.white_koth
            : victor === players.BLACK ? resultTranslations.black_koth
                : resultTranslations.bug_koth;
    else if (condition === 'stalemate')
        return resultTranslations.draw_stalemate;
    else if (condition === 'repetition')
        return resultTranslations.draw_repetition;
    else if (condition === 'moverule')
        return drawMoveRule();
    else if (condition === 'insuffmat')
        return resultTranslations.draw_insuffmat;
    console.error(`Game conclusion: "${conclusion}"\nVictor: ${victor}\nCondition: ${condition}`);
    return resultTranslations.bug_generic;
}
/** Returns the height of the game info bar in the document, in virtual pixels. */
function getHeightOfGameInfoBar() {
    return element_gameInfoBar.getBoundingClientRect().height;
}
export default {
    open,
    close,
    update_GameControlButtons,
    revealPlayerNames,
    hidePlayerNames,
    toggle,
    updateWhosTurn,
    gameEnd,
    getResultText,
    getHeightOfGameInfoBar,
};
