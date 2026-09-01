/**
 * The thing standing behind you when you stop playing.
 *
 * A single textured quad, standing on the board at the spot directly behind the player at
 * the moment it appeared. That spot is pinned once and then left alone, so the only way to
 * see it is to turn around. Which also means it only exists in perspective mode — in the
 * normal top-down view there is no "behind".
 *
 * `idlenudge` decides *when* to show it. This script only knows how to draw it.
 */
import frametracker from './frametracker.js';
import { createModel } from './buffermodel.js';
// @ts-ignore
import camera from './camera.js';
// @ts-ignore
import perspective from './perspective.js';
// @ts-ignore
import texture from './texture.js';
// @ts-ignore
import { gl } from './webgl.js';
// Constants -------------------------------------------------------------
/** Served out of `src/client/img`. Same-origin, which the CSP (`imgSrc 'self'`) requires. */
const IMAGE_URL = '/img/chuying.png';
/** Aspect ratio of the image, used so the quad doesn't stretch it. Read off the texture once loaded. */
const FALLBACK_ASPECT = 842 / 833;
/**
 * How far behind the player it stands, as a multiple of the camera's height above the board.
 *
 * Measured against the camera rather than in board squares so the apparent size doesn't
 * change when the player zooms. Slightly more than the camera's height, which is what puts
 * the whole figure on screen at once: the ground it stands on is then just inside the
 * bottom of the frustum when the player is looking at the horizon.
 */
const DISTANCE_FACTOR = 1.1;
/**
 * How tall it is, as a multiple of the camera's height above the board.
 *
 * It stands on the board rather than floating at eye level, so its height is what decides
 * how far up the screen it reaches. At 1.7 it is a little taller than the camera is high,
 * which reads as a figure looming over the player rather than a picture hung in the air.
 */
const HEIGHT_FACTOR = 1.7;
/** Never fully opaque — a solid rectangle reads as a bug, a translucent one as an apparition. */
const MAX_ALPHA = 0.9;
const FADE_IN_MILLIS = 500;
const FADE_OUT_MILLIS = 900;
/** 6 vertices * (3 position + 2 texcoord + 4 color). */
const FLOATS_PER_VERTEX = 9;
const VERTEX_COUNT = 6;
// State -------------------------------------------------------------
/** `Date.now()` when it should disappear. Zero means it isn't showing. */
let visibleUntil = 0;
/** `Date.now()` when it appeared, for the fade-in. */
let shownAt = 0;
/**
 * The yaw, in degrees, that the player was facing when it appeared.
 *
 * This is the whole trick. The quad's world position is derived from THIS, not from the
 * player's live rotation — otherwise it would swing round with them and sit permanently
 * behind their head, which no amount of turning could ever reveal. Pinned once, it stays
 * put, and turning around brings it into view.
 *
 * Undefined until we have a yaw worth pinning, which means until perspective mode is on.
 */
let anchorYaw;
let glTexture;
let textureState = 'none';
let aspect = FALLBACK_ASPECT;
/** Rebuilt in place every frame — the quad turns with the player. */
let model;
// Showing / hiding -------------------------------------------------------------
/** Whether it is on screen right now (or would be, if the player were in perspective mode). */
function isShowing() {
    return Date.now() < visibleUntil;
}
/** Puts it behind the player for `millis`. Starts fetching the image if this is the first time. */
function show(millis) {
    const now = Date.now();
    shownAt = now;
    visibleUntil = now + millis;
    anchorYaw = undefined; // Re-pinned below, or on the first frame perspective mode is on
    ensureAnchor();
    void ensureTexture();
    frametracker.onVisualChange();
}
function hide() {
    if (visibleUntil === 0)
        return;
    visibleUntil = 0;
    anchorYaw = undefined;
    frametracker.onVisualChange();
}
/**
 * Pins the spot it stands on, the first frame we're able to.
 *
 * Deferred rather than done in {@link show}, because the player may not have been in
 * perspective mode when the timer went off, and "behind you" has no meaning in the
 * top-down view. Waiting means it appears behind wherever they were facing when they
 * looked up, instead of behind whichever way the board happened to be turned.
 */
function ensureAnchor() {
    if (anchorYaw === undefined && perspective.getEnabled())
        anchorYaw = perspective.getRotZ();
    return anchorYaw;
}
/**
 * Keeps frames coming while it's on screen.
 *
 * The engine only redraws when something says it changed, and an idle player by
 * definition isn't generating those. Without this the fade would freeze mid-way.
 */
function update() {
    if (!isShowing())
        return;
    if (!perspective.getEnabled())
        return;
    ensureAnchor();
    frametracker.onVisualChange();
}
// The texture -------------------------------------------------------------
/** Loads the image once, ever. A failure is remembered so we don't retry every frame. */
function ensureTexture() {
    if (textureState !== 'none')
        return;
    textureState = 'loading';
    const image = new Image();
    image.onload = () => {
        try {
            glTexture = texture.loadTexture(gl, image);
            if (image.naturalHeight > 0)
                aspect = image.naturalWidth / image.naturalHeight;
            textureState = 'ready';
            frametracker.onVisualChange();
        }
        catch (error) {
            textureState = 'failed';
            console.error(`Could not turn ${IMAGE_URL} into a texture.`, error);
        }
    };
    image.onerror = () => {
        textureState = 'failed';
        console.warn(`Could not load ${IMAGE_URL}. Nothing will appear behind the player.`);
    };
    image.src = IMAGE_URL;
}
// Rendering -------------------------------------------------------------
/** 0 while hidden, ramping up on arrival and back down before it leaves. */
function getAlpha(now) {
    const fadeIn = Math.min(1, (now - shownAt) / FADE_IN_MILLIS);
    const fadeOut = Math.min(1, (visibleUntil - now) / FADE_OUT_MILLIS);
    return Math.max(0, Math.min(fadeIn, fadeOut)) * MAX_ALPHA;
}
/**
 * Writes the quad into `model.data`.
 *
 * The view matrix rotates the whole world about the camera (see `perspective.applyRotations`),
 * so with the player looking at the horizon the direction they face works out to
 * `(sin rotZ, cos rotZ, 0)` on the board plane — +y at rotZ 0, which is white's view. Behind
 * them is the negation of that, and their right hand points along `(cos rotZ, -sin rotZ, 0)`.
 *
 * `yaw` is the pinned {@link anchorYaw}, NOT the live rotation, which is the only reason any
 * of this is visible: the position is fixed in the world, so turning 180° brings it round to
 * the front. Deriving it from the live yaw instead keeps it exactly behind the player forever.
 *
 * It stands ON the board (world z 0 up to `height`) rather than being centred at eye level.
 * That costs nothing when the player is looking at the horizon and gains a lot when they
 * aren't: a figure occupying the ground and the air above it stays in frame across most of
 * the pitch range, where one floating at eye level only shows up at a level gaze.
 */
function writeVertexData(data, alpha, yaw) {
    const radians = yaw * (Math.PI / 180);
    const sin = Math.sin(radians);
    const cos = Math.cos(radians);
    const cameraPos = camera.getPosition(); // devMode-sensitive, so the sizing below must be too
    const camHeight = cameraPos[2];
    const distance = camHeight * DISTANCE_FACTOR;
    const height = camHeight * HEIGHT_FACTOR;
    const halfWidth = height * aspect / 2;
    // Behind where the player was facing, on the board plane.
    const centerX = cameraPos[0] - sin * distance;
    const centerY = cameraPos[1] - cos * distance;
    // Their right hand, scaled to half the quad's width.
    const rightX = cos * halfWidth;
    const rightY = -sin * halfWidth;
    const left = [centerX - rightX, centerY - rightY];
    const right = [centerX + rightX, centerY + rightY];
    const bottom = 0; // The board itself is drawn at world z 0, so this stands on it
    const top = height;
    // `texture.loadTexture` flips the image vertically, so v=0 is its bottom edge.
    const corners = [
        [left[0], left[1], bottom, 0, 0],
        [left[0], left[1], top, 0, 1],
        [right[0], right[1], bottom, 1, 0],
        [right[0], right[1], bottom, 1, 0],
        [left[0], left[1], top, 0, 1],
        [right[0], right[1], top, 1, 1],
    ];
    for (let i = 0; i < VERTEX_COUNT; i++) {
        const [x, y, z, u, v] = corners[i];
        const o = i * FLOATS_PER_VERTEX;
        data[o] = x;
        data[o + 1] = y;
        data[o + 2] = z;
        data[o + 3] = u;
        data[o + 4] = v;
        data[o + 5] = 1;
        data[o + 6] = 1;
        data[o + 7] = 1;
        data[o + 8] = alpha;
    }
}
/**
 * Draws it, if it's due. Call from inside the depth-ALWAYS block of the render loop, before
 * the crosshair — the crosshair should stay on top of it.
 */
function render() {
    if (!perspective.getEnabled())
        return; // There is no "behind you" in the top-down view
    if (textureState !== 'ready' || glTexture === undefined)
        return;
    const now = Date.now();
    if (now >= visibleUntil)
        return;
    const alpha = getAlpha(now);
    if (alpha <= 0)
        return;
    const yaw = ensureAnchor();
    if (yaw === undefined)
        return; // Nowhere pinned yet
    if (model === undefined) {
        model = createModel(new Float32Array(VERTEX_COUNT * FLOATS_PER_VERTEX), 3, 'TRIANGLES', true, glTexture);
    }
    const data = model.data;
    writeVertexData(data, alpha, yaw);
    model.updateBufferIndices(0, data.length);
    model.render();
}
export default {
    isShowing,
    show,
    hide,
    update,
    render,
};
