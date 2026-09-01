/**
 * Notices when the player has stopped playing, and does something about it.
 *
 * One minute without a move, while it's the player's turn, and two things happen:
 * the coach volunteers a suggestion in the chat panel, and — if the player is in
 * perspective mode — something appears behind them for a minute.
 *
 * The clock is measured in moves, not in mouse activity, because "hasn't moved in a
 * minute" is the thing worth reacting to. Panning the board while thinking shouldn't
 * reset it, and it doesn't.
 */
import gameslot from '../chess/gameslot.js';
import gamefileutility from '../../chess/util/gamefileutility.js';
import onlinegame from './onlinegame/onlinegame.js';
import enginegame from './enginegame.js';
import guiaicoach from '../gui/guiaicoach.js';
import idleghost from '../rendering/idleghost.js';
// Constants -------------------------------------------------------------
/** How long the player may sit on their turn before we step in. */
const IDLE_MILLIS = 60_000;
/** How long the thing behind them stays. */
const GHOST_MILLIS = 60_000;
// State -------------------------------------------------------------
/** `gamefile.moves.length` last time we looked, so we can spot a move being played. */
let lastMoveCount = -1;
/** `Date.now()` when the current turn started waiting on the player. Undefined when it isn't. */
let waitingSince;
/** The move count we already nudged at, so it fires once per turn rather than once per frame. */
let nudgedAtMoveCount = -1;
// -------------------------------------------------------------
/** Whether the game is waiting on the person at the keyboard specifically. */
function isWaitingOnPlayer(gamefile) {
    if (gamefileutility.isGameOver(gamefile))
        return false;
    if (onlinegame.areInOnlineGame())
        return onlinegame.isItOurTurn();
    if (enginegame.areInEngineGame()) {
        // A thinking AI hasn't handed the turn over yet, whatever the move list says.
        return enginegame.isItOurTurn() && !enginegame.isAIOpponentThinking();
    }
    return true; // Local game — every move is theirs
}
function forget() {
    waitingSince = undefined;
    nudgedAtMoveCount = -1;
    lastMoveCount = -1;
}
/** Called every frame from the game loop. Cheap: a couple of comparisons on the quiet path. */
function update() {
    idleghost.update();
    const gamefile = gameslot.getGamefile();
    if (gamefile === undefined) {
        if (lastMoveCount !== -1) { // A game was loaded a moment ago and now isn't
            forget();
            idleghost.hide();
        }
        return;
    }
    const moveCount = gamefile.moves.length;
    if (moveCount !== lastMoveCount) {
        // Somebody moved. Start the turn fresh, and call off anything the last one triggered.
        lastMoveCount = moveCount;
        waitingSince = undefined;
        idleghost.hide();
    }
    if (!isWaitingOnPlayer(gamefile)) {
        waitingSince = undefined;
        return;
    }
    const now = Date.now();
    if (waitingSince === undefined) {
        waitingSince = now;
        return;
    }
    if (nudgedAtMoveCount === moveCount)
        return; // Already stepped in on this turn
    if (now - waitingSince < IDLE_MILLIS)
        return;
    nudgedAtMoveCount = moveCount;
    idleghost.show(GHOST_MILLIS);
    guiaicoach.onPlayerIdle();
}
export default {
    update,
};
