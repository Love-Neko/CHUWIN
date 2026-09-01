/**
 * This script contains the default movesets for all pieces except specials (pawns, castling)
 */
import typeutil from '../util/typeutil.js';
import math from '../../util/math.js';
import { rawTypes } from '../util/typeutil.js';
// @ts-ignore
import specialdetect from './specialdetect.js';
// @ts-ignore
import isprime from '../../util/isprime.js';
/** The default blocking function of each piece's sliding moves, if not specified. */
function defaultBlockingFunction(friendlyColor, blockingPiece) {
    const colorOfBlockingPiece = typeutil.getColorFromType(blockingPiece.type);
    const isVoid = typeutil.getRawType(blockingPiece.type) === rawTypes.VOID;
    if (friendlyColor === colorOfBlockingPiece || isVoid)
        return 1; // Block where it is if it is a friendly OR a void square.
    else
        return 2; // Allow the capture if enemy, but block afterward
}
/** The default ignore function of each piece's sliding moves, if not specified. */
function defaultIgnoreFunction() {
    return true; // Square allowed
}
/**
 * Returns the movesets of all the pieces, modified according to the specified slideLimit gamerule.
 *
 * These movesets are called as functions so that they return brand
 * new copies of each moveset so there's no risk of accidentally modifying the originals.
 * @param [slideLimit] Optional. The slideLimit gamerule value.
 * @returns Object containing the movesets of all pieces except pawns.
 */
function getPieceDefaultMovesets(slideLimit = Infinity) {
    if (typeof slideLimit !== 'number')
        throw new Error("slideLimit gamerule is in an unsupported value.");
    return {
        // Finitely moving
        [rawTypes.PAWN]: {
            special: specialdetect.pawns
        },
        [rawTypes.KNIGHT]: {
            individual: [
                [-2, 1], [-1, 2], [1, 2], [2, 1],
                [-2, -1], [-1, -2], [1, -2], [2, -1]
            ]
        },
        [rawTypes.HAWK]: {
            individual: [
                [-3, 0], [-2, 0], [2, 0], [3, 0],
                [0, -3], [0, -2], [0, 2], [0, 3],
                [-2, -2], [-2, 2], [2, -2], [2, 2],
                [-3, -3], [-3, 3], [3, -3], [3, 3]
            ]
        },
        [rawTypes.KING]: {
            individual: [
                [-1, 0], [-1, 1], [0, 1], [1, 1],
                [1, 0], [1, -1], [0, -1], [-1, -1]
            ],
            special: specialdetect.kings
        },
        [rawTypes.GUARD]: {
            individual: [
                [-1, 0], [-1, 1], [0, 1], [1, 1],
                [1, 0], [1, -1], [0, -1], [-1, -1]
            ]
        },
        // Infinitely moving
        [rawTypes.ROOK]: {
            sliding: {
                '1,0': [-slideLimit, slideLimit],
                '0,1': [-slideLimit, slideLimit]
            }
        },
        [rawTypes.BISHOP]: {
            sliding: {
                '1,1': [-slideLimit, slideLimit],
                '1,-1': [-slideLimit, slideLimit]
            }
        },
        [rawTypes.QUEEN]: {
            sliding: {
                '1,0': [-slideLimit, slideLimit],
                '0,1': [-slideLimit, slideLimit],
                '1,1': [-slideLimit, slideLimit],
                '1,-1': [-slideLimit, slideLimit]
            }
        },
        [rawTypes.ROYALQUEEN]: {
            sliding: {
                '1,0': [-slideLimit, slideLimit],
                '0,1': [-slideLimit, slideLimit],
                '1,1': [-slideLimit, slideLimit],
                '1,-1': [-slideLimit, slideLimit]
            }
        },
        [rawTypes.CHANCELLOR]: {
            individual: [
                [-2, 1], [-1, 2], [1, 2], [2, 1],
                [-2, -1], [-1, -2], [1, -2], [2, -1]
            ],
            sliding: {
                '1,0': [-slideLimit, slideLimit],
                '0,1': [-slideLimit, slideLimit]
            }
        },
        [rawTypes.ARCHBISHOP]: {
            individual: [
                [-2, 1], [-1, 2], [1, 2], [2, 1],
                [-2, -1], [-1, -2], [1, -2], [2, -1]
            ],
            sliding: {
                '1,1': [-slideLimit, slideLimit],
                '1,-1': [-slideLimit, slideLimit]
            }
        },
        [rawTypes.AMAZON]: {
            individual: [
                [-2, 1], [-1, 2], [1, 2], [2, 1],
                [-2, -1], [-1, -2], [1, -2], [2, -1]
            ],
            sliding: {
                '1,0': [-slideLimit, slideLimit],
                '0,1': [-slideLimit, slideLimit],
                '1,1': [-slideLimit, slideLimit],
                '1,-1': [-slideLimit, slideLimit]
            }
        },
        [rawTypes.CAMEL]: {
            individual: [
                [-3, 1], [-1, 3], [1, 3], [3, 1],
                [-3, -1], [-1, -3], [1, -3], [3, -1]
            ]
        },
        [rawTypes.GIRAFFE]: {
            individual: [
                [-4, 1], [-1, 4], [1, 4], [4, 1],
                [-4, -1], [-1, -4], [1, -4], [4, -1]
            ]
        },
        [rawTypes.ZEBRA]: {
            individual: [
                [-3, 2], [-2, 3], [2, 3], [3, 2],
                [-3, -2], [-2, -3], [2, -3], [3, -2]
            ]
        },
        [rawTypes.KNIGHTRIDER]: {
            sliding: {
                '1,2': [-slideLimit, slideLimit],
                '1,-2': [-slideLimit, slideLimit],
                '2,1': [-slideLimit, slideLimit],
                '2,-1': [-slideLimit, slideLimit],
            }
        },
        [rawTypes.CENTAUR]: {
            individual: [
                // Guard moveset
                [-1, 0], [-1, 1], [0, 1], [1, 1],
                [1, 0], [1, -1], [0, -1], [-1, -1],
                // + Knight moveset!
                [-2, 1], [-1, 2], [1, 2], [2, 1],
                [-2, -1], [-1, -2], [1, -2], [2, -1]
            ]
        },
        [rawTypes.ROYALCENTAUR]: {
            individual: [
                // Guard moveset
                [-1, 0], [-1, 1], [0, 1], [1, 1],
                [1, 0], [1, -1], [0, -1], [-1, -1],
                // + Knight moveset!
                [-2, 1], [-1, 2], [1, 2], [2, 1],
                [-2, -1], [-1, -2], [1, -2], [2, -1]
            ],
            special: specialdetect.kings
        },
        [rawTypes.HUYGEN]: {
            sliding: {
                '1,0': [-slideLimit, slideLimit],
                '0,1': [-slideLimit, slideLimit]
            },
            blocking: (friendlyColor, blockingPiece, coords) => {
                const distance = math.chebyshevDistance(coords, blockingPiece.coords);
                const isPrime = isprime.primalityTest(distance, null);
                if (!isPrime)
                    return 0; // Doesn't block
                const colorOfBlockingPiece = typeutil.getColorFromType(blockingPiece.type);
                if (colorOfBlockingPiece === friendlyColor)
                    return 1; // Friendly piece blocked
                else
                    return 2; // Enemy piece blocked
            },
            ignore: (startCoords, endCoords) => {
                const distance = math.chebyshevDistance(startCoords, endCoords);
                const isPrime = isprime.primalityTest(distance, null);
                return isPrime;
            }
        },
        [rawTypes.ROSE]: {
            special: specialdetect.roses
        }
    };
}
/**
 * Calculates all possible slides that should be possible in the provided game,
 * based on the provided movesets.
 * @param pieceMovesets - MUST BE TRIMMED beforehand to not include movesets of types not present in the game!!!!!
 */
function getPossibleSlides(pieceMovesets) {
    const slides = new Set(['1,0']); // '1,0' is required if castling is enabled.
    for (const rawtype in pieceMovesets) {
        const moveset = pieceMovesets[rawtype]();
        if (!moveset.sliding)
            continue;
        Object.keys(moveset.sliding).forEach(slide => slides.add(slide));
    }
    return Array.from(slides, math.getVec2FromKey);
}
export default {
    defaultBlockingFunction,
    defaultIgnoreFunction,
    getPieceDefaultMovesets,
    getPossibleSlides,
};
