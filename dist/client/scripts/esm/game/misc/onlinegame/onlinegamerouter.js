import disconnect from "./disconnect.js";
import afk from "./afk.js";
import serverrestart from "./serverrestart.js";
import movesendreceive from "./movesendreceive.js";
import resyncer from "./resyncer.js";
import drawoffers from "./drawoffers.js";
import gameloader from "../../chess/gameloader.js";
import gameslot from "../../chess/gameslot.js";
import guititle from "../../gui/guititle.js";
import clock from "../../../chess/logic/clock.js";
import selection from "../../chess/selection.js";
import onlinegame from "./onlinegame.js";
// @ts-ignore
import guiplay from "../../gui/guiplay.js";
// @ts-ignore
import websocket from "../../websocket.js";
// @ts-ignore
import statustext from "../../gui/statustext.js";
// @ts-ignore
import guiclock from "../../gui/guiclock.js";
// @ts-ignore
import board from "../../rendering/board.js";
;
// Routers --------------------------------------------------------------------------------------
/**
 * Routes a server websocket message with subscription marked `game`.
 * This handles all messages related to the active game we're in.
 * @param {WebsocketMessage} data - The incoming server websocket message
 */
function routeMessage(data) {
    // console.log(`Received ${data.action} from server! Message contents:`)
    // console.log(data.value)
    // This action is listened to, even when we're not in a game.
    if (data.action === 'joingame')
        return handleJoinGame(data.value);
    // All other actions should be ignored if we're not in a game...
    if (!onlinegame.areInOnlineGame()) {
        console.log(`Received server 'game' message when we're not in an online game. Ignoring. Message: ${JSON.stringify(data)}`);
        return;
    }
    const gamefile = gameslot.getGamefile();
    switch (data.action) {
        case "move":
            movesendreceive.handleOpponentsMove(gamefile, data.value);
            break;
        case "clock":
            handleUpdatedClock(gamefile, data.value);
            break;
        case "gameupdate":
            resyncer.handleServerGameUpdate(gamefile, data.value);
            break;
        case "unsub":
            handleUnsubbing();
            break;
        case "login":
            handleLogin(gamefile);
            break;
        case "nogame": // Game is deleted / no longer exists
            handleNoGame(gamefile);
            break;
        case "leavegame":
            handleLeaveGame();
            break;
        case "opponentafk":
            afk.startOpponentAFKCountdown(data.value.millisUntilAutoAFKResign);
            break;
        case "opponentafkreturn":
            afk.stopOpponentAFKCountdown();
            break;
        case "opponentdisconnect":
            disconnect.startOpponentDisconnectCountdown(data.value);
            break;
        case "opponentdisconnectreturn":
            disconnect.stopOpponentDisconnectCountdown();
            break;
        case "serverrestart":
            serverrestart.initServerRestart(data.value);
            break;
        case "drawoffer":
            drawoffers.onOpponentExtendedOffer();
            break;
        case "declinedraw":
            drawoffers.onOpponentDeclinedOffer();
            break;
        default:
            statustext.showStatus(`Unknown action "${data.action}" received from server in 'game' route.`, true);
            break;
    }
}
/**
 * Joins a game when the server tells us we are now in one.
 *
 * This happens when we click an invite, or our invite is accepted.
 *
 * This type of message contains the MOST information about the game.
 * Less then "gameupdate"s, or resyncing.
 */
function handleJoinGame(message) {
    // We were auto-unsubbed from the invites list, BUT we want to keep open the socket!!
    websocket.deleteSub('invites');
    websocket.addSub('game');
    guititle.close();
    guiplay.close();
    // If the clock values are present, adjust them for ping.
    if (message.clockValues)
        message.clockValues = onlinegame.adjustClockValuesForPing(message.clockValues);
    gameloader.startOnlineGame(message);
}
/**
 * Called when we received the updated clock values from the server after submitting our move.
 */
function handleUpdatedClock(gamefile, clockValues) {
    // Adjust the timer whos turn it is depending on ping.
    if (clockValues)
        clockValues = onlinegame.adjustClockValuesForPing(clockValues);
    clock.edit(gamefile, clockValues); // Edit the clocks
    guiclock.edit(gamefile);
}
/**
 * Called after the server deletes the game after it has ended.
 * It basically tells us the server will no longer be sending updates related to the game,
 * so we should just unsub.
 *
 * Called when the server informs us they have unsubbed us from receiving updates from the game.
 * At this point we should leave the game.
 */
function handleUnsubbing() {
    websocket.deleteSub('game');
}
/**
 * The server has unsubscribed us from receiving updates from the game
 * and from submitting actions as ourselves,
 * due to the reason we are no longer logged in.
 */
function handleLogin(gamefile) {
    statustext.showStatus(translations['onlinegame'].not_logged_in, true, 100);
    websocket.deleteSub('game');
    clock.endGame(gamefile);
    guiclock.stopClocks(gamefile);
    selection.unselectPiece();
    board.darkenColor();
}
/**
 * The server has reported the game no longer exists,
 * there will be nore more updates for it.
 *
 * Visually, abort the game.
 *
 * This can happen when either:
 * * Your page tries to resync to the game after it's long over.
 * * The server restarts mid-game.
 */
function handleNoGame(gamefile) {
    statustext.showStatus(translations['onlinegame'].game_no_longer_exists, false, 1.5);
    websocket.deleteSub('game');
    gamefile.gameConclusion = 'aborted';
    gameslot.concludeGame();
}
/**
 * You have connected to the same game from another window/device.
 * Leave the game on this page.
 *
 * This allows you to return to the invite creation screen,
 * but you won't be allowed to create an invite if you're still in a game.
 * However you can start a local game.
 */
function handleLeaveGame() {
    statustext.showStatus(translations['onlinegame'].another_window_connected);
    websocket.deleteSub('game');
    gameloader.unloadGame();
    guititle.open();
}
export default {
    routeMessage,
};
