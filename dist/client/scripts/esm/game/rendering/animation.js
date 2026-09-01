/**
 * This script handles the animation of pieces.
 * It also plays the sounds.
 */
import arrows from './arrows/arrows.js';
import { createModel } from './buffermodel.js';
import frametracker from './frametracker.js';
import math from '../../util/math.js';
import splines from '../../util/splines.js';
import coordutil from '../../chess/util/coordutil.js';
import spritesheet from './spritesheet.js';
import boardpos from './boardpos.js';
// @ts-ignore
import typeutil from '../../chess/util/typeutil.js';
// @ts-ignore
import bufferdata from './bufferdata.js';
// @ts-ignore
import sound from '../misc/sound.js';
// @ts-ignore
import board from './board.js';
// @ts-ignore
import perspective from './perspective.js';
// @ts-ignore
import shapes from './shapes.js';
// @ts-ignore
import statustext from '../gui/statustext.js';
// Constants -------------------------------------------------------------------
/** Config for the splines. */
const SPLINES = {
    RESOLUTION: 10, // Default: 10
    WIDTH: 0.15, // Default: 0.15
    COLOR: [1, 0, 0, 1] // Default: [1, 0, 0, 1]
};
/**
 * The z offset of the transparent square meant to block out the default
 * rendering of the pieces while the animation is visible.
 *
 * THIS MUST BE GREATER THAN THE Z AT WHICH PIECES ARE RENDERED.
 */
const TRANSPARENT_SQUARE_Z = 0.01;
/** By adding a negative offset, the sound doesn't appear delayed. */
const SOUND_OFFSET = -100;
/** The maximum distance an animation can be without teleporting mid-animation. */
const MAX_DISTANCE_BEFORE_TELEPORT = 80; // 80
/** Used for calculating the duration of move animations. */
const MOVE_ANIMATION_DURATION = {
    /** The base amount of duration, in millis. */
    baseMillis: 150, // Default: 150
    /** The multiplier amount of duration, in millis, multiplied by the capped move distance. */
    multiplierMillis: 6,
    /** The multiplierMillis when there's atleast 3+ waypoints */
    multiplierMillis_Curved: 12, // Default: 12
    /** Replaces {@link MOVE_ANIMATION_DURATION.baseMillis} when {@link DEBUG} is true. */
    baseMillis_Debug: 2000,
    /** Replaces {@link MOVE_ANIMATION_DURATION.multiplierMillis} when {@link DEBUG} is true. */
    multiplierMillis_Debug: 30,
    /** Replaces {@link MOVE_ANIMATION_DURATION.multiplierMillis_Curved} when {@link DEBUG} is true. */
    multiplierMillis_Curved_Debug: 60,
};
// Variables -------------------------------------------------------------------------------
/** The list of all current animations */
const animations = [];
/** If this is enabled, the spline of the animations will be rendered, and the animations' duration increased. */
let DEBUG = false;
// Adding / Clearing Animations -----------------------------------------------------------------------
/**
 * Animates a piece after moving it.
 * @param type - The type of piece to animate
 * @param path - The waypoints the piece will pass throughout the animation. Minimum: 2
 * @param captured - The piece captured, if one was captured. This will be rendered in place for the during of the animation.
 * @param instant - If true, the piece was dropped and should not be animated. The SOUND will still be played.
 * @param resetAnimations - If false, allows animation of multiple pieces at once. Useful for castling. Default: true
 */
function animatePiece(type, path, captured, instant, resetAnimations = true) {
    if (path.length < 2)
        throw new Error("Animation requires at least 2 waypoints");
    if (resetAnimations)
        clearAnimations(true);
    // Generate smooth spline waypoints
    const path_HighResolution = splines.generateSplinePath(path, SPLINES.RESOLUTION);
    const segments = createAnimationSegments(path_HighResolution);
    // Calculates the total length of the path traveled by the piece in the animation.
    const totalDistance = segments.reduce((sum, seg) => sum + seg.distance, 0);
    // Check if the piece type doesn't have an SVG (void). If not, we can't animate it.
    if (typeutil.SVGLESS_TYPES.some((typeNoSVG) => {
        return typeutil.getRawType(type) === typeNoSVG || (captured !== undefined && typeutil.getRawType(captured.type) === typeNoSVG);
    }))
        instant = true; // But, still instant animate it so that the sound plays
    // Handle instant animation (piece was dropped): Play the SOUND ONLY, but don't animate.
    if (instant)
        return playSoundOfDistance(totalDistance, captured !== undefined);
    const newAnimation = {
        type,
        path: path_HighResolution,
        segments,
        captured,
        startTimeMillis: performance.now(),
        durationMillis: calculateAnimationDuration(totalDistance, path_HighResolution.length),
        totalDistance,
        soundPlayed: false
    };
    scheduleSoundPlayback(newAnimation);
    scheduleAnimationRemoval(newAnimation);
    animations.push(newAnimation);
}
/**
 * Terminates all animations.
 *
 * Should be called when we're skipping through moves quickly
 * (in that scenario we immediately play the sound),
 * or when the game is unloaded.
 */
function clearAnimations(playSounds = false) {
    animations.forEach(animation => {
        clearTimeout(animation.soundTimeoutId); // Don't play it twice..
        clearTimeout(animation.scheduledRemovalId); // Don't remove it twice..
        if (playSounds && !animation.soundPlayed)
            playAnimationSound(animation); // .. play it NOW.
    });
    animations.length = 0; // Empties existing animations
}
function toggleDebug() {
    DEBUG = !DEBUG;
    statustext.showStatus(`Toggled animation splines: ${DEBUG}`, false, 0.5);
}
// Helper Functions -----------------------------------------------------------
/** Creates the segments between each waypoint. */
function createAnimationSegments(waypoints) {
    const segments = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
        const start = waypoints[i];
        const end = waypoints[i + 1];
        segments.push({
            start,
            end,
            distance: math.euclideanDistance(start, end)
        });
    }
    return segments;
}
/** Calculates the duration in milliseconds a particular move would take to animate. */
function calculateAnimationDuration(totalDistance, waypointCount) {
    const baseMillis = DEBUG ? MOVE_ANIMATION_DURATION.baseMillis_Debug : MOVE_ANIMATION_DURATION.baseMillis;
    const cappedDist = Math.min(totalDistance, MAX_DISTANCE_BEFORE_TELEPORT);
    let multiplier;
    if (DEBUG)
        multiplier = waypointCount > 2 ? MOVE_ANIMATION_DURATION.multiplierMillis_Curved_Debug : MOVE_ANIMATION_DURATION.multiplierMillis_Debug;
    else
        multiplier = waypointCount > 2 ? MOVE_ANIMATION_DURATION.multiplierMillis_Curved : MOVE_ANIMATION_DURATION.multiplierMillis;
    const additionMillis = cappedDist * multiplier;
    return baseMillis + additionMillis;
}
/** Schedules the playback of the sound of the animation. */
function scheduleSoundPlayback(animation) {
    const playbackTime = Math.max(0, animation.durationMillis + SOUND_OFFSET);
    animation.soundTimeoutId = setTimeout(() => playAnimationSound(animation), playbackTime);
}
/** Schedules the removal of an animation after it's over. */
function scheduleAnimationRemoval(animation) {
    animation.scheduledRemovalId = setTimeout(() => {
        const index = animations.indexOf(animation);
        if (index === -1)
            return; // Already removed
        animations.splice(index, 1);
        frametracker.onVisualChange();
    }, animation.durationMillis);
}
/**
 * Plays the sound of the animation.
 * @param animation - The animation to play the sound for.
 * @param dampen - Whether to dampen the sound. This should be true if we're skipping through moves quickly.
 */
function playAnimationSound(animation) {
    playSoundOfDistance(animation.totalDistance, animation.captured !== undefined);
    animation.soundPlayed = true;
}
/** Plays the sound of a move from just the distance traveled and whether it made a capture. */
function playSoundOfDistance(distance, captured) {
    if (captured)
        sound.playSound_capture(distance);
    else
        sound.playSound_move(distance);
}
// Updating -------------------------------------------------------------------------------
/** Flags the frame to be rendered if there are any animations, and adds an arrow indicator animation for each */
function update() {
    if (animations.length === 0)
        return;
    frametracker.onVisualChange();
    animations.forEach(animation => shiftArrowIndicatorOfAnimatedPiece(animation)); // Animate the arrow indicator
}
/** Animates the arrow indicator */
function shiftArrowIndicatorOfAnimatedPiece(animation) {
    const animationCurrentCoords = getCurrentAnimationPosition(animation);
    arrows.shiftArrow(animation.type, false, animation.path[animation.path.length - 1], animationCurrentCoords);
    // Add the captured piece only after we've shifted the piece that captured it
    if (animation.captured !== undefined)
        arrows.shiftArrow(animation.captured.type, true, undefined, animation.captured.coords);
}
// Rendering -------------------------------------------------------------------------------
/**
 * Renders the transparent squares that block out the default rendering of the pieces while the animation is visible.
 * This works because they are higher in the depth buffer than the pieces.
 */
function renderTransparentSquares() {
    if (!animations.length)
        return;
    const color = [0, 0, 0, 0];
    // Calls map() on each animation, and then flats() the results into a single array.
    const data = animations.flatMap(animation => shapes.getTransformedDataQuad_Color_FromCoord(animation.path[animation.path.length - 1], color));
    createModel(data, 2, "TRIANGLES", true)
        .render([0, 0, TRANSPARENT_SQUARE_Z]);
}
/** Renders the animations of the pieces. */
function renderAnimations() {
    if (animations.length === 0)
        return;
    if (DEBUG)
        animations.forEach(animation => splines.renderSplineDebug(animation.path, SPLINES.WIDTH, SPLINES.COLOR));
    // Calls map() on each animation, and then flats() the results into a single array.
    const data = animations.flatMap(animation => {
        const currentPos = getCurrentAnimationPosition(animation);
        const piecesData = [];
        if (animation.captured)
            piecesData.push(...generatePieceData(animation.captured.type, animation.captured.coords)); // Render the captured piece
        piecesData.push(...generatePieceData(animation.type, currentPos)); // Render the moving piece
        return piecesData;
    });
    createModel(data, 2, "TRIANGLES", false, spritesheet.getSpritesheet()).render();
}
/**
 * Adds the vertex data of the piece of an animation to the data array.
 * @param data - The running list of data to append to.
 * @param type - The type of piece the data and animation is for.
 * @param coords - The coordinates of the piece of the animation.
*/
function generatePieceData(type, coords) {
    const rotation = perspective.getIsViewingBlackPerspective() ? -1 : 1;
    const { texleft, texbottom, texright, textop } = bufferdata.getTexDataOfType(type, rotation);
    const { startX, startY, endX, endY } = calculateBoardPosition(coords);
    return bufferdata.getDataQuad_Texture(startX, startY, endX, endY, texleft, texbottom, texright, textop);
}
/** Calculates the position of a piece on the board from its coordinates. */
function calculateBoardPosition(coords) {
    const boardPos = boardpos.getBoardPos();
    const boardScale = boardpos.getBoardScale();
    const squareCenter = board.gsquareCenter();
    const startX = (coords[0] - boardPos[0] - squareCenter) * boardScale;
    const startY = (coords[1] - boardPos[1] - squareCenter) * boardScale;
    return {
        startX,
        startY,
        endX: startX + 1 * boardScale,
        endY: startY + 1 * boardScale
    };
}
// Animation Calculations -----------------------------------------------------
/**
 * Returns the coordinate the animation's piece should be rendered this frame.
 * @param animation - The animation to calculate the position for.
 * @param maxDistB4Teleport - The maximum distance the animation should be allowed to travel before teleporting mid-animation near the end of its destination. This should be specified if we're animating a miniimage, since when we're zoomed out, the animation moving faster is perceivable.
 */
function getCurrentAnimationPosition(animation, maxDistB4Teleport = MAX_DISTANCE_BEFORE_TELEPORT) {
    const elapsed = performance.now() - animation.startTimeMillis;
    /** The interpolated progress of the animation. */
    const t = Math.min(elapsed / animation.durationMillis, 1);
    /** The eased progress of the animation. */
    const easedT = math.easeInOut(t);
    return calculateInterpolatedPosition(animation, easedT, maxDistB4Teleport);
}
/** Returns the coordinate the animation's piece should be rendered at a certain eased progress. */
function calculateInterpolatedPosition(animation, easedProgress, MAX_DISTANCE) {
    const targetDistance = animation.totalDistance <= MAX_DISTANCE ? easedProgress * animation.totalDistance : calculateTeleportDistance(animation.totalDistance, easedProgress, MAX_DISTANCE);
    return findPositionInSegments(animation.segments, targetDistance);
}
/** Calculates the distance the piece animation should be rendered along the path, when the total distance is great enough to merit teleporting. */
function calculateTeleportDistance(totalDistance, easedProgress, MAX_DISTANCE) {
    // First half
    if (easedProgress < 0.5)
        return easedProgress * 2 * (MAX_DISTANCE / 2);
    // Second half: animate final portion of path
    const portionFromEnd = (easedProgress - 0.5) * 2 * (MAX_DISTANCE / 2);
    return (totalDistance - MAX_DISTANCE / 2) + portionFromEnd;
}
/** Finds the position of the piece at a certain distance along the path. */
function findPositionInSegments(segments, targetDistance) {
    let accumulated = 0;
    for (const segment of segments) {
        if (targetDistance <= accumulated + segment.distance) {
            const segmentProgress = (targetDistance - accumulated) / segment.distance;
            return coordutil.lerpCoords(segment.start, segment.end, segmentProgress);
        }
        accumulated += segment.distance;
    }
    return segments[segments.length - 1].end;
}
// -----------------------------------------------------------------------------------------
export default {
    animations,
    animatePiece,
    clearAnimations,
    toggleDebug,
    update,
    renderTransparentSquares,
    renderAnimations,
    getCurrentAnimationPosition,
};
