/**
 * This script stores the type definition for a game's metadata.
 *
 * ICN (Infinite Chess Notation) is inspired from PGN notation.
 * https://github.com/tsevasa/infinite-chess-notation
 */
import { players } from "./typeutil.js";
// getMetadataOfGame()
/**
 * Returns the value of the game's Result metadata, depending on the victor.
 * @param victor - The victor of the game, in player number. Or none if undefined.
 * @returns The result of the game in the format '1-0', '0-1', '0.5-0.5', or '*' (aborted).
 */
function getResultFromVictor(victor) {
    if (victor === players.WHITE)
        return '1-0';
    else if (victor === players.BLACK)
        return '0-1';
    else if (victor === players.NEUTRAL)
        return '1/2-1/2';
    else if (victor === undefined)
        return '*';
    throw new Error(`Cannot get game result from unsupported victor ${victor}!`);
}
export default {
    getResultFromVictor,
};
