/**
 * This script contains utility methods for working with coordinates [x,y].
 *
 * ZERO dependancies.
 */
// Functions -------------------------------------------------------------------
/**
 * Checks if both the x-coordinate and the y-coordinate of a point are integers.
 */
function areCoordsIntegers(coords) {
    return Number.isInteger(coords[0]) && Number.isInteger(coords[1]);
}
// /**
//  * ALTERNATIVE to {@link areCoordsIntegers}, if we end up having floating point imprecision problems!
//  *
//  * Checks if a number is effectively an integer considering floating point imprecision.
//  * @param {number} num - The number to check.
//  * @param {number} [epsilon=Number.EPSILON] - The tolerance for floating point imprecision.
//  * @returns {boolean} - Returns true if the number is effectively an integer, otherwise false.
//  */
// function isEffectivelyInteger(num, epsilon = Number.EPSILON) {
//     return Math.abs(num - Math.round(num)) < epsilon;
// }
/** Returns the key string of the coordinates: [x,y] => 'x,y' */
function getKeyFromCoords(coords) {
    // Casting to BigInt and back to a string avoids scientific notation.
    // toFixed(0) doesn't work for numbers above 10^21
    return `${BigInt(coords[0])},${BigInt(coords[1])}`;
}
/**
 * Returns a length-2 array of the provided coordinates
 * @param key - 'x,y'
 * @returns The coordinates of the piece, [x,y]
 */
function getCoordsFromKey(key) {
    return key.split(',').map(Number);
}
/**
 * Returns true if the coordinates are equal.
 *
 * If one coordinate isn't provided, they are considered not equal.
 */
function areCoordsEqual(coord1, coord2) {
    if (!coord1 || !coord2)
        return false; // One undefined, can't be equal
    return coord1[0] === coord2[0] && coord1[1] === coord2[1];
}
/**
 * Returns true if the coordinates are equal
 */
function areCoordsEqual_noValidate(coord1, coord2) {
    return coord1[0] === coord2[0] && coord1[1] === coord2[1];
}
/**
 * Adds two coordinate pairs together component-wise.
 */
function addCoordinates(coord1, coord2) {
    return [
        coord1[0] + coord2[0],
        coord1[1] + coord2[1]
    ];
}
/**
 * Subtracts two coordinate pairs together component-wise.
 * @param minuendCoord - The first coordinate pair [x1, y1] to start with.
 * @param subtrahendCoord - The second coordinate pair [x2, y2] to subtract from the minuend.
 * @returns The resulting coordinate pair after subtracting.
 */
function subtractCoordinates(minuendCoord, subtrahendCoord) {
    return [
        minuendCoord[0] - subtrahendCoord[0],
        minuendCoord[1] - subtrahendCoord[1]
    ];
}
/**
 * Makes a deep copy of the provided coordinates
 */
function copyCoords(coords) {
    return [...coords];
}
/**
 * Interpolates between two coordinates.
 * @param start - The starting coordinate.
 * @param end - The ending coordinate.
 * @param t - The interpolation value (between 0 and 1).
 */
function lerpCoords(start, end, t) {
    return [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
    ];
}
export default {
    areCoordsIntegers,
    getKeyFromCoords,
    getCoordsFromKey,
    areCoordsEqual,
    areCoordsEqual_noValidate,
    addCoordinates,
    subtractCoordinates,
    copyCoords,
    lerpCoords,
};
