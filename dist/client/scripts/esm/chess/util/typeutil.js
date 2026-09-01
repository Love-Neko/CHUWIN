/**
 * This script contains lists of all piece types and players,
 * and utility methods for working with them.
 */
/**
 * Every raw type of piece supported in the game.
 *
 * This exact arrangement affects the order of which
 * the checkmate algorithm searches for legal moves,
 * and it affects the order the miniimages of the
 * pieces are rendered when zoomed out.
 */
const rawTypes = {
    VOID: 0,
    OBSTACLE: 1,
    KING: 2,
    GIRAFFE: 3,
    CAMEL: 4,
    ZEBRA: 5,
    KNIGHTRIDER: 6,
    AMAZON: 7,
    QUEEN: 8,
    ROYALQUEEN: 9,
    HAWK: 10,
    CHANCELLOR: 11,
    ARCHBISHOP: 12,
    CENTAUR: 13,
    ROYALCENTAUR: 14,
    ROSE: 15,
    KNIGHT: 16,
    GUARD: 17,
    HUYGEN: 18,
    ROOK: 19,
    BISHOP: 20,
    PAWN: 21
};
const neutralRawTypes = [rawTypes.VOID, rawTypes.OBSTACLE];
/** All player colors suppored in the game. Multiply the raw type by this to get the colored type. */
const players = {
    NEUTRAL: 0,
    WHITE: 1,
    BLACK: 2,
    // Colored players
    RED: 3,
    BLUE: 4,
    YELLOW: 5,
    GREEN: 6,
};
const numTypes = Object.keys(rawTypes).length;
/** Color extensions of all players. Add this to a raw type to get the colored type. */
const ext = {
    N: players.NEUTRAL * numTypes,
    W: players.WHITE * numTypes,
    B: players.BLACK * numTypes,
    // Colored players
    R: players.RED * numTypes,
    BU: players.BLUE * numTypes,
    Y: players.YELLOW * numTypes,
    G: players.GREEN * numTypes,
};
/**
 * The string representations of each raw type.
 *
 * MUST BE IN THE EXACT SAME ORDER AS {@link rawTypes}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
const strtypes = ['void', 'obstacle', 'king', 'giraffe', 'camel', 'zebra', 'knightrider', 'amazon', 'queen', 'royalQueen', 'hawk', 'chancellor', 'archbishop', 'centaur', 'royalCentaur', 'rose', 'knight', 'guard', 'huygen', 'rook', 'bishop', 'pawn'];
/** A list of the royals that are compatible with checkmate. If a royal can slide, DO NOT put it in here, put it in {@link slidingRoyals} instead! */
const jumpingRoyals = [rawTypes.KING, rawTypes.ROYALCENTAUR];
/**
 * A list of the royals that the checkmate algorithm cannot detect when they are in checkmate,
 * however it still is illegal to move into check.
 *
 * Players have to voluntarily resign if they
 * believe their sliding royal is in checkmate.
 */
const slidingRoyals = [rawTypes.ROYALQUEEN];
/**
 * A list of the royal pieces, without the color appended.
 * THIS SHOULD NOT CONTAIN DUPLICATES
 */
const royals = [...jumpingRoyals, ...slidingRoyals];
/**
 * The string representations of each player color.
 *
 * MUST BE IN THE EXACT SAME ORDER AS {@link players}!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
const strcolors = ["neutral", "white", "black", "red", "blue", "yellow", "green"];
/** Raw piece types that don't have an SVG */
const SVGLESS_TYPES = [rawTypes.VOID];
function getRawType(type) {
    return type % numTypes;
}
function getColorFromType(type) {
    return Math.floor(type / numTypes);
}
function buildType(type, color) {
    return type + color * numTypes;
}
/** Splits a type into its raw type and player */
function splitType(type) {
    return [getRawType(type), getColorFromType(type)];
}
/** Repeats each rawTypes for player color provided. */
function buildAllTypesForPlayers(players, rawTypes) {
    const builtTypes = [];
    for (let i = players.length - 1; i >= 0; i--) {
        for (const r of rawTypes) {
            builtTypes.push(buildType(r, players[i]));
        }
    }
    return builtTypes;
}
// eslint-disable-next-line no-unused-vars
function forEachPieceType(callback, players, includePieces) {
    for (let i = players.length - 1; i >= 0; i--) {
        for (const r of includePieces) {
            callback(buildType(r, players[i]));
        }
    }
}
function invertType(type) {
    const [r, p] = splitType(type);
    const newp = invertPlayer(p); // This will throw an error if the type is not invertible because of its color. (We should never attempt to invert it anyway)
    return buildType(r, newp);
}
function invertPlayer(player) {
    return player === players.WHITE ? players.BLACK :
        player === players.BLACK ? players.WHITE
            : (() => { throw Error(`Cannot invert player ${player}!`); })(); // No downsides to adding this, only more protection.
}
function getRawTypeStr(type) {
    return strtypes[type];
}
function getPlayerFromString(string) {
    return strcolors.indexOf(string);
}
function debugType(type) {
    const [raw, c] = splitType(type);
    return `[${type}] ${getRawTypeStr(raw)}(${strcolors[c]})`;
}
export { rawTypes, neutralRawTypes, ext, numTypes, players, };
export default {
    jumpingRoyals,
    slidingRoyals,
    royals,
    SVGLESS_TYPES,
    strcolors,
    getRawType,
    getColorFromType,
    buildType,
    splitType,
    invertType,
    buildAllTypesForPlayers,
    forEachPieceType,
    getRawTypeStr,
    invertPlayer,
    getPlayerFromString,
    debugType
};
