/**
 * This script keeps track of both players timer,
 * updates them each frame,
 * and the update() method will return the loser
 * if somebody loses on time.
 */
import moveutil from '../util/moveutil.js';
import timeutil from '../../util/timeutil.js';
import gamefileutility from '../util/gamefileutility.js';
import typeutil from '../util/typeutil.js';
// @ts-ignore
import clockutil from '../util/clockutil.js';
;
// Functions -----------------------------------------------------------------------
/**
 * Sets the clocks. If no current clock values are specified, clocks will
 * be set to the starting values, according to the game's TimeControl metadata.
 * @param gamefile
 * @param [currentTimes] Optional. An object containing the current times of the players. Often used if we re-joining an online game.
 */
function set(gamefile, currentTimes) {
    const clock = gamefile.metadata.TimeControl; // "600+5"
    gamefile.untimed = clockutil.isClockValueInfinite(clock);
    if (gamefile.untimed) {
        gamefile.clocks = undefined;
        return;
    }
    // { minutes, increment }
    const clockPartsSplit = clockutil.getMinutesAndIncrementFromClock(clock);
    const clocks = {
        startTime: {
            minutes: clockPartsSplit.minutes,
            millis: timeutil.minutesToMillis(clockPartsSplit.minutes),
            increment: clockPartsSplit.increment
        },
        currentTime: {},
        colorTicking: undefined,
        timeAtTurnStart: undefined,
        timeRemainAtTurnStart: undefined
    };
    gamefile.clocks = clocks;
    // Edit the closk if we're re-loading an online game
    if (currentTimes)
        edit(gamefile, currentTimes);
    else { // No current time specified, start both players with the default.
        gamefile.gameRules.turnOrder.forEach((color) => {
            clocks.currentTime[color] = clocks.startTime.millis;
        });
    }
}
/**
 * Updates the gamefile with new clock information received from the server.
 * @param gamefile - The current game state object containing clock information.
 * @param [clockValues] - An object containing the updated clock values.
 */
function edit(gamefile, clockValues) {
    if (!clockValues || gamefile.untimed)
        return; // Likely a no-timed game
    const clocks = gamefile.clocks;
    const colorTicking = gamefile.whosTurn;
    if (clockValues.colorTicking !== undefined) {
        // Adjust the clock value according to the precalculated time they will lost by timeout.
        if (clockValues.timeColorTickingLosesAt === undefined)
            throw Error('clockValues should have been modified to account for ping BEFORE editing the clocks. Use adjustClockValuesForPing() beore edit()');
        const colorTickingTrueTimeRemaining = clockValues.timeColorTickingLosesAt - Date.now();
        // @ts-ignore
        clockValues.clocks[colorTicking] = colorTickingTrueTimeRemaining;
    }
    clocks.colorTicking = colorTicking;
    clocks.currentTime = { ...clockValues.clocks };
    const now = Date.now();
    clocks.timeAtTurnStart = now;
    clocks.timeRemainAtTurnStart = clocks.currentTime[clocks.colorTicking];
}
/**
 * Call after flipping whosTurn. Flips colorTicking in local games.
 */
function push(gamefile) {
    if (gamefile.untimed)
        return;
    if (!moveutil.isGameResignable(gamefile))
        return; // Don't push unless atleast 2 moves have been played
    const clocks = gamefile.clocks;
    clocks.colorTicking = gamefile.whosTurn;
    // Add increment if the last move has a clock ticking
    if (clocks.timeAtTurnStart !== undefined) {
        const prevcolor = moveutil.getWhosTurnAtMoveIndex(gamefile, gamefile.moves.length - 2);
        clocks.currentTime[prevcolor] += timeutil.secondsToMillis(clocks.startTime.increment);
    }
    clocks.timeRemainAtTurnStart = clocks.currentTime[clocks.colorTicking];
    clocks.timeAtTurnStart = Date.now();
}
function endGame(gamefile) {
    if (gamefile.untimed)
        return;
    const clocks = gamefile.clocks;
    clocks.timeRemainAtTurnStart = undefined;
    clocks.timeAtTurnStart = undefined;
    clocks.colorTicking = undefined;
}
/**
 * Called every frame, updates values.
 * @param gamefile
 * @returns undefined if clocks still have time, otherwise it's the color who won.
*/
function update(gamefile) {
    if (gamefile.untimed || gamefileutility.isGameOver(gamefile) || !moveutil.isGameResignable(gamefile))
        return;
    const clocks = gamefile.clocks;
    if (clocks.timeAtTurnStart === undefined)
        return;
    // Update current values
    const timePassedSinceTurnStart = Date.now() - clocks.timeAtTurnStart;
    clocks.currentTime[clocks.colorTicking] = Math.ceil(clocks.timeRemainAtTurnStart - timePassedSinceTurnStart);
    for (const [playerStr, time] of Object.entries(clocks.currentTime)) {
        const player = Number(playerStr);
        if (time <= 0) {
            clocks.currentTime[playerStr] = 0;
            return typeutil.invertPlayer(player); // The color who won on time
        }
    }
    return; // Without this, typescript complains not all code paths return a value.
}
/**
 * Returns the true time remaining for the player whos clock is ticking.
 * Independant of reading clocks.currentTime, because that isn't updated
 * every frame if the user unfocuses the window.
 */
function getColorTickingTrueTimeRemaining(gamefile) {
    if (gamefile.untimed)
        return;
    const clocks = gamefile.clocks;
    if (clocks.colorTicking === undefined)
        return;
    const timeElapsedSinceTurnStartMillis = Date.now() - clocks.timeAtTurnStart;
    return clocks.timeRemainAtTurnStart - timeElapsedSinceTurnStartMillis;
}
function printClocks(gamefile) {
    if (gamefile.untimed)
        return console.log("Game is untimed.");
    const clocks = gamefile.clocks;
    for (const color in clocks.currentTime) {
        console.log(`${color} time: ${clocks.currentTime[color]}`);
    }
    console.log(`timeRemainAtTurnStart: ${clocks.timeRemainAtTurnStart}`);
    console.log(`timeAtTurnStart: ${clocks.timeAtTurnStart}`);
}
export default {
    set,
    edit,
    endGame,
    update,
    push,
    getColorTickingTrueTimeRemaining,
    printClocks,
};
