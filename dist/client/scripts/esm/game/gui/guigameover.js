/**
 * The screen that appears once a game has ended, offering a rematch or a trip
 * back to the title screen.
 *
 * It is opened from `gameslot.concludeGame()`, which fires exactly once per game.
 * `guigameinfo.gameEnd()` looks like the natural hook but is not one: `updateWhosTurn()`
 * calls it again on every turn update once the game is over, which would re-open the
 * panel every time the user rewound a move after dismissing it.
 */
import gameloader from "../chess/gameloader.js";
import { players } from "../../chess/util/typeutil.js";
import guiaicoach from "./guiaicoach.js";
import guieasteregg from "./guieasteregg.js";
import guititle from "./guititle.js";
import enginegame from "../misc/enginegame.js";
import onlinegame from "../misc/onlinegame/onlinegame.js";
import guigameinfo from "./guigameinfo.js";
// @ts-ignore
import winconutil from "../../chess/util/winconutil.js";
// Variables --------------------------------------------------------------------
const element_gameoverUI = document.getElementById('gameoverUI');
const element_headline = document.getElementById('gameover-headline');
const element_detail = document.getElementById('gameover-detail');
const element_rematch = document.getElementById('gameover-rematch');
const element_mainmenu = document.getElementById('gameover-mainmenu');
const element_dismiss = document.getElementById('gameover-dismiss');
/** Whether the game over screen is currently showing. */
let isOpen = false;
// Helpers --------------------------------------------------------------------
/** Looks up `[play.javascript.gameover]` from the injected translations. */
function tr(key, fallback) {
    if (typeof translations === 'undefined')
        return fallback;
    const group = translations['gameover'];
    const value = group === undefined || group === null ? undefined : group[key];
    return typeof value === 'string' && value !== '' ? value : fallback;
}
/**
 * Our colour in the finished game, if the game had a side that was ours.
 * A local hotseat game doesn't — both sides were played by the same person.
 */
function getOurColorOrUndefined() {
    try {
        if (onlinegame.areInOnlineGame())
            return onlinegame.getOurColor();
        if (enginegame.areInEngineGame())
            return enginegame.getOurColor();
    }
    catch {
        return undefined; // Asking after the game was already torn down
    }
    return undefined;
}
/** Win / loss / draw, from the point of view of whoever is sitting at the keyboard. */
function getHeadline(conclusion) {
    const { victor } = winconutil.getVictorAndConditionFromGameConclusion(conclusion);
    if (victor === players.NEUTRAL || victor === undefined)
        return tr('draw', 'Draw');
    const ourColor = getOurColorOrUndefined();
    if (ourColor === undefined) { // Hotseat: name the winning side, since both sides were ours
        return victor === players.WHITE ? tr('white_wins', 'White wins') : tr('black_wins', 'Black wins');
    }
    return victor === ourColor ? tr('you_win', 'You win!') : tr('you_lose', 'You lose');
}
/**
 * Win or loss from the point of view of whoever is sitting at the keyboard, or
 * `undefined` when the finished game had no side of ours to win with: a draw, or a
 * hotseat game, where the person who won is also the person who lost.
 */
function getOutcome(conclusion) {
    const { victor } = winconutil.getVictorAndConditionFromGameConclusion(conclusion);
    if (victor === players.NEUTRAL || victor === undefined)
        return undefined;
    const ourColor = getOurColorOrUndefined();
    if (ourColor === undefined)
        return undefined;
    return victor === ourColor ? 'win' : 'lose';
}
// Open / Close --------------------------------------------------------------------
/** Whether the game over screen is currently showing. */
function areOpen() { return isOpen; }
/**
 * Shows the game over screen for the given conclusion.
 * Called once, from `gameslot.concludeGame()`.
 */
function open(conclusion) {
    if (conclusion === false)
        return; // Nothing to report
    element_headline.textContent = getHeadline(conclusion);
    element_detail.textContent = guigameinfo.getResultText(conclusion);
    // Online games have no rematch: that would need the opponent to agree to one.
    const canReplay = gameloader.canReplayLastGame() && !onlinegame.areInOnlineGame();
    element_rematch.classList.toggle('hidden', !canReplay);
    element_gameoverUI.classList.remove('hidden');
    if (!isOpen)
        initListeners();
    isOpen = true;
    // The easter egg. Only for a game we won or lost — a draw is nobody's moment.
    const outcome = getOutcome(conclusion);
    if (outcome !== undefined)
        guieasteregg.show(outcome);
}
/** Hides the screen, leaving the finished game on the board. */
function close() {
    if (isOpen)
        closeListeners();
    isOpen = false;
    element_gameoverUI.classList.add('hidden');
    guieasteregg.hide(); // Usually already gone: the click that got us here dismissed it
}
function initListeners() {
    element_rematch.addEventListener('click', callback_rematch);
    element_mainmenu.addEventListener('click', callback_mainMenu);
    element_dismiss.addEventListener('click', close);
}
function closeListeners() {
    element_rematch.removeEventListener('click', callback_rematch);
    element_mainmenu.removeEventListener('click', callback_mainMenu);
    element_dismiss.removeEventListener('click', close);
}
// Callbacks --------------------------------------------------------------------
/** Starts another game with exactly the options the finished one used. */
function callback_rematch() {
    const vsLLM = gameloader.wasLastGameVsLLM();
    close();
    // The chat history survives on purpose: the coach persona tracks how the
    // player is doing across games, so it should remember the game just played.
    guiaicoach.onNewGame();
    gameloader.replayLastGame().then(() => {
        if (vsLLM)
            guiaicoach.open(); // The chat box is how you talk to your opponent
    }).catch((err) => console.error(err));
}
/** Tears the game down and returns to the title screen. Mirrors guipause's main menu button. */
function callback_mainMenu() {
    close();
    onlinegame.onMainMenuPress();
    guiaicoach.reset(); // The panel is meaningless without a game behind it
    gameloader.unloadGame();
    guititle.open();
}
export default {
    areOpen,
    open,
    close,
};
