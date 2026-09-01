/**
 * The win / loss easter egg.
 *
 * When a game ends in a win or a loss, a picture starts orbiting the middle of the
 * screen and a song starts playing. The player's next click takes both away, and the
 * next decided game brings them back.
 *
 * The assets live in the project's own `yinpin/` folder, which the server mounts at
 * `/yinpin` (see `middleware.js`). They are deliberately NOT copied into `src/client`:
 * `build.js` wipes and refills `dist` on every build, and these are megabytes of media
 * the user swaps out by hand.
 */
const ASSETS = {
    // Chinese file names on purpose — these are the user's own files, named by them.
    win: { image: 'ying.png', song: '胜利.mp3' },
    lose: { image: 'shu.png', song: '泥肘.mp3' },
};
/** How many copies of the picture ride the orbit. */
const COPIES = 6;
/** Seconds for one lap. Must match the `egg-orbit` animation in play.css. */
const ORBIT_SECONDS = 2.6;
/** Seconds for one turn of a picture about its own middle. Matches `egg-spin`. */
const SPIN_SECONDS = 0.75;
/**
 * How long after appearing the egg refuses to be dismissed.
 *
 * The game can end on the player's own click — the move that delivers mate. That
 * gesture's `click` is still on its way when we get here, so without this the egg
 * would flash and vanish inside the same press that earned it.
 */
const GRACE_MILLIS = 500;
const element_layer = document.getElementById('egg-layer');
/** The song, while it is playing. */
let song;
/** Whether the egg is on screen right now. */
let isShowing = false;
/** `performance.now()` from which a click is allowed to dismiss the egg. */
let dismissableAt = 0;
// Helpers --------------------------------------------------------------------
/** The URL of one of the user's files. Their names are not ASCII, so they need encoding. */
function url(filename) {
    return `/yinpin/${encodeURIComponent(filename)}`;
}
/** Builds the ring of pictures, spread evenly around the orbit by negative delays. */
function buildPictures(image) {
    const pictures = [];
    for (let i = 0; i < COPIES; i++) {
        const orbit = document.createElement('div');
        orbit.className = 'egg-orbit';
        // A negative delay starts the animation partway through, which is what puts
        // this copy at its own angle on the ring instead of all six on top of each other.
        orbit.style.animationDelay = `${-(ORBIT_SECONDS * i) / COPIES}s`;
        const picture = document.createElement('img');
        picture.src = url(image);
        picture.alt = '';
        picture.draggable = false;
        picture.style.animationDelay = `${-(SPIN_SECONDS * i) / COPIES}s`;
        orbit.appendChild(picture);
        pictures.push(orbit);
    }
    element_layer.replaceChildren(...pictures);
}
/** Starts the song. A failure here is not worth interrupting anything over. */
function startSong(filename) {
    try {
        song = new Audio(url(filename));
        song.volume = 0.85;
        // Browsers only allow this off the back of a user gesture. By the time a game
        // has been played there always has been one, but a rejection is still possible
        // (a muted device, a missing file), and the pictures should survive it.
        song.play().catch(() => { });
    }
    catch {
        song = undefined;
    }
}
function stopSong() {
    if (song === undefined)
        return;
    try {
        song.pause();
        song.currentTime = 0;
    }
    catch {
        // Already torn down by the browser; nothing left to stop.
    }
    song = undefined;
}
// Show / Hide --------------------------------------------------------------------
/** Whether the egg is on screen right now. */
function areShowing() { return isShowing; }
/** Puts the picture and the song for this result on screen. Called by `guigameover.open()`. */
function show(outcome) {
    const assets = ASSETS[outcome];
    hide(); // Replaces whatever a previous game left behind
    buildPictures(assets.image);
    element_layer.classList.remove('hidden');
    startSong(assets.song);
    isShowing = true;
    dismissableAt = performance.now() + GRACE_MILLIS;
    // Capturing, and without swallowing the event: the click that dismisses the egg
    // should still reach the game over card underneath, so "play again" works first try.
    document.addEventListener('pointerdown', callback_dismiss, true);
    document.addEventListener('keydown', callback_dismiss, true);
}
/** Takes the picture and the song away. Safe to call when nothing is showing. */
function hide() {
    if (isShowing) {
        document.removeEventListener('pointerdown', callback_dismiss, true);
        document.removeEventListener('keydown', callback_dismiss, true);
    }
    isShowing = false;
    stopSong();
    element_layer.classList.add('hidden');
    element_layer.replaceChildren();
}
function callback_dismiss() {
    if (performance.now() < dismissableAt)
        return;
    hide();
}
export default {
    areShowing,
    show,
    hide,
};
