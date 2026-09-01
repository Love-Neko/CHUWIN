/**
 * Future new input script that can listen for inputs on specific elements,
 * not only on the document.
 *
 * Also, we will need built-in double-click and triple-click detection
 * for mapping tools to, such as ray/arrow drawing.
 */
import docutil from "../util/docutil.js";
const Mouse = {
    LEFT: 0,
    MIDDLE: 1,
    RIGHT: 2,
};
// Maps buttons to string names
const MouseNames = {
    [Mouse.LEFT]: 'Left',
    [Mouse.MIDDLE]: 'Middle',
    [Mouse.RIGHT]: 'Right',
};
/** Options for simulated clicks */
const CLICK_THRESHOLDS = {
    MOUSE: {
        /** The maximum distance the mouse can move before a click is not registered. */
        MOVE_VPIXELS: 8, // Default: 8
        /** The maximum time the mouse can be held down before a click is not registered. */
        TIME_MILLIS: 400, // Default: 400
        /** The maximum time between first click down and second click up to register a double click drag. */
        DOUBLE_CLICK_TIME_MILLIS: 500,
    },
    TOUCH: {
        /** {@link CLICK_THRESHOLDS.MOUSE.MOVE_VPIXELS}, but for fingers (less strict, the 2nd tap can be further away) */
        MOVE_VPIXELS: 24,
        /** {@link CLICK_THRESHOLDS.MOUSE.TIME_MILLIS}, but for fingers (more strict, they must lift quicker) */
        TIME_MILLIS: 120,
        /** {@link CLICK_THRESHOLDS.MOUSE.DOUBLE_CLICK_TIME_MILLIS}, but for fingers (more strict, they must lift quicker) */
        DOUBLE_CLICK_TIME_MILLIS: 250, // Default: 220
    }
};
/** The window of milliseconds to store mouse position history for velocity calculations. */
const MOUSE_POS_HISTORY_WINDOW_MILLIS = 80;
/**
 * Creates an input listener that listens to mouse and keyboard events on the given element.
 *
 * EVERY FRAME you need to dispatch the 'reset-listener-events' event on the document
 * to reset the state of the input listener.
 * @param element - The HTML element to listen for events on.
 * @returns An object with methods to check the state of mouse and keyboard inputs.
 */
function CreateInputListener(element, { keyboard = true, mouse = true } = {}) {
    const keyDowns = [];
    const keyHelds = [];
    /** The amount the scroll wheel has scrolled this frame. */
    let wheelDelta = 0;
    /** The keys are the finger ids, if its a finger, or 'mouse' if it's the mouse. */
    const pointers = {};
    /** A list of all pointer id's that were left-click pressed down this frame. */
    const pointersDown = [];
    // console.log("Mouse supported: ", docutil.isMouseSupported());
    // Immediately add the mouse pointer if the doc supports it
    if (docutil.isMouseSupported()) {
        pointers['mouse'] = {
            isTouch: false,
            id: 'mouse',
            isHeld: false,
            position: [0, 0],
            delta: [0, 0],
            positionHistory: [],
            velocity: [0, 0],
        };
    }
    /** Whether there has been any input this frame. */
    let atleastOneInputThisFrame = false;
    const clickInfo = {
        [Mouse.LEFT]: { isDown: false, isHeld: false, clicked: false, doubleClickDrag: false, timeDownMillisHistory: [], deltaSinceDown: [0, 0] },
        [Mouse.MIDDLE]: { isDown: false, isHeld: false, clicked: false, doubleClickDrag: false, timeDownMillisHistory: [], deltaSinceDown: [0, 0] },
        [Mouse.RIGHT]: { isDown: false, isHeld: false, clicked: false, doubleClickDrag: false, timeDownMillisHistory: [], deltaSinceDown: [0, 0] },
    };
    const eventHandlers = {};
    // Helper Functions ---------------------------------------------------------------------------
    function addListener(target, eventType, handler) {
        target.addEventListener(eventType, handler);
        eventHandlers[eventType] = { target, handler };
    }
    ;
    /** Reset the input events for the next frame. Fire 'reset-listener-events' event at the very end of EVERY frame. */
    document.addEventListener('reset-listener-events', () => {
        // console.log("Resetting events");
        // We can continuously hold a key without triggering more events, so held keys should still count as an input that frame.
        // atleastOneInputThisFrame = keyHelds.length > 0 || Object.values(clickInfo).some(clickInfo => clickInfo.isHeld);
        atleastOneInputThisFrame = keyHelds.length > 0;
        // console.log("Atleast one input this frame: ", atleastOneInputThisFrame);
        // For each mouse button, reset its state
        for (const button of Object.values(clickInfo)) {
            button.isDown = false;
            button.clicked = false;
            button.doubleClickDrag = false;
            // Trim their timeDownMillisHistory of old mouse downs
            button.timeDownMillisHistory = button.timeDownMillisHistory.filter(time => time > Date.now() - 3000);
        }
        // For each pointer, reset its state
        const now = Date.now();
        for (const pointer of Object.values(pointers)) {
            pointer.delta = [0, 0];
            pointer.positionHistory = pointer.positionHistory.filter(entry => entry.time > Date.now() - MOUSE_POS_HISTORY_WINDOW_MILLIS);
            recalcPointerVel(pointer, now);
        }
        keyDowns.length = 0;
        pointersDown.length = 0;
        wheelDelta = 0;
    });
    /** Calculates the mouse velocity based on recent mouse positions. */
    function recalcPointerVel(pointer, now) {
        // Remove old entries, stop once we encounter recent enough data
        const timeToRemoveEntriesBefore = now - MOUSE_POS_HISTORY_WINDOW_MILLIS;
        while (pointer.positionHistory.length > 0 && pointer.positionHistory[0].time < timeToRemoveEntriesBefore)
            pointer.positionHistory.shift();
        // Calculate velocity if there are at least two positions
        if (pointer.positionHistory.length >= 2) {
            const latestMousePosEntry = pointer.positionHistory[pointer.positionHistory.length - 1];
            const firstMousePosEntry = pointer.positionHistory[0]; // { mousePos, time }
            const timeDiffBetwFirstAndLastEntryMillis = (latestMousePosEntry.time - firstMousePosEntry.time);
            const mVX = (latestMousePosEntry.pos[0] - firstMousePosEntry.pos[0]) / timeDiffBetwFirstAndLastEntryMillis;
            const mVY = (latestMousePosEntry.pos[1] - firstMousePosEntry.pos[1]) / timeDiffBetwFirstAndLastEntryMillis;
            pointer.velocity = [mVX, mVY];
        }
        else
            pointer.velocity = [0, 0];
    }
    // Simulated Click Events (either mouse or finger) ------------------------------------------------------------
    function updateClickInfoDown(targetButton, e) {
        // console.log("Mouse down: ", MouseNames[targetButton]);
        const targetButtonInfo = clickInfo[targetButton];
        const pointerId = e instanceof MouseEvent ? 'mouse' : e.identifier.toString(); // CAN'T USE instanceof Touch because it's not defined in Safari!
        targetButtonInfo.pointerId = pointerId;
        targetButtonInfo.isDown = true;
        targetButtonInfo.isHeld = true;
        const relativeMousePos = getRelativeMousePosition([e.clientX, e.clientY], element);
        targetButtonInfo.position = [...relativeMousePos];
        if (targetButton === Mouse.LEFT)
            pointersDown.push(targetButtonInfo.pointerId);
        if (pointers[pointerId])
            pointers[pointerId].isHeld = true; // Mark the pointer as held down
        else
            throw Error(`Pointer of id (${pointerId}) wasn't added to pointers list.`);
        // Update click ------------
        const previousTimeDown = targetButtonInfo.timeDownMillisHistory[targetButtonInfo.timeDownMillisHistory.length - 1];
        const now = Date.now();
        targetButtonInfo.timeDownMillisHistory.push(now);
        // Update double click draw ----------
        const DOUBLE_CLICK_TIME_MILLIS = e instanceof MouseEvent ? CLICK_THRESHOLDS.MOUSE.DOUBLE_CLICK_TIME_MILLIS : CLICK_THRESHOLDS.TOUCH.DOUBLE_CLICK_TIME_MILLIS; // CAN'T USE instanceof Touch because it's not defined in Safari!
        if (previousTimeDown && now - previousTimeDown < DOUBLE_CLICK_TIME_MILLIS) {
            // Mouse has been down atleast once before.
            // Now we now posDown will be defined, so we can calculate the distance to that last click down.
            // Works for 2D mode, desktop & mobile
            const posDown = clickInfo[targetButton].posDown;
            const distMoved = posDown ? Math.max(Math.abs(posDown[0] - relativeMousePos[0]), Math.abs(posDown[1] - relativeMousePos[1])) : 0;
            // Works for 3D mode, desktop (mouse is locked in place then)
            const delta = Math.max(Math.abs(targetButtonInfo.deltaSinceDown[0]), Math.abs(targetButtonInfo.deltaSinceDown[1]));
            const MOVE_VPIXELS = e instanceof MouseEvent ? CLICK_THRESHOLDS.MOUSE.MOVE_VPIXELS : CLICK_THRESHOLDS.TOUCH.MOVE_VPIXELS; // CAN'T USE instanceof Touch because it's not defined in Safari!
            if (distMoved < MOVE_VPIXELS && delta < MOVE_VPIXELS) { // Only register the double click drag if the mouse hasn't moved too far from its last click down.
                targetButtonInfo.doubleClickDrag = true;
                // console.log("Mouse double click dragged: ", MouseNames[targetButton]);
            }
            // else console.log("Mouse double click MOVED TOO FAR: ", MouseNames[targetButton]);
        } // ----------------
        // Now we can update the last click down after checking for its distance to the last one.
        targetButtonInfo.posDown = [...relativeMousePos];
        targetButtonInfo.deltaSinceDown = [0, 0]; // Reset the delta since down
    }
    function updateClickInfoUp(targetButton, e) {
        // console.log("Mouse up: ", MouseNames[targetButton]);
        const targetButtonInfo = clickInfo[targetButton];
        const pointerId = e instanceof MouseEvent ? 'mouse' : e.identifier.toString(); // CAN'T USE instanceof Touch because it's not defined in Safari!
        targetButtonInfo.pointerId = pointerId;
        targetButtonInfo.isDown = false;
        targetButtonInfo.isHeld = false;
        const relativeMousePos = getRelativeMousePosition([e.clientX, e.clientY], element);
        targetButtonInfo.position = [...relativeMousePos];
        // Remove the pointer from the list of pointers down too, if it's in there.
        // This can happen if it was added & removed in a single frame.
        const index = pointersDown.indexOf(targetButtonInfo.pointerId);
        if (index !== -1)
            pointersDown.splice(index, 1);
        if (pointers[pointerId])
            pointers[pointerId].isHeld = false; // Mark the pointer as no longer held down
        // Update click --------------
        const mouseHistory = clickInfo[targetButton].timeDownMillisHistory;
        const timePassed = Date.now() - (mouseHistory[mouseHistory.length - 1] ?? 0); // Since the latest click
        const TIME_MILLIS = e instanceof MouseEvent ? CLICK_THRESHOLDS.MOUSE.TIME_MILLIS : CLICK_THRESHOLDS.TOUCH.TIME_MILLIS; // CAN'T USE instanceof Touch because it's not defined in Safari!
        if (timePassed < TIME_MILLIS) {
            // Works for 2D mode, desktop & mobile
            const posDown = clickInfo[targetButton].posDown;
            const distMoved = posDown ? Math.max(Math.abs(posDown[0] - relativeMousePos[0]), Math.abs(posDown[1] - relativeMousePos[1])) : 0; // No click down to compare to. This can happen if you click down offscreen.
            // Works for 3D mode, desktop (mouse is locked in place then)
            const delta = Math.max(Math.abs(clickInfo[targetButton].deltaSinceDown[0]), Math.abs(clickInfo[targetButton].deltaSinceDown[1]));
            const MOVE_VPIXELS = e instanceof MouseEvent ? CLICK_THRESHOLDS.MOUSE.MOVE_VPIXELS : CLICK_THRESHOLDS.TOUCH.MOVE_VPIXELS; // CAN'T USE instanceof Touch because it's not defined in Safari!
            if (distMoved < MOVE_VPIXELS && delta < MOVE_VPIXELS) {
                clickInfo[targetButton].clicked = true;
                // console.log("Mouse clicked: ", MouseNames[targetButton]);
            }
        } // --------------
    }
    if (mouse) {
        // Mouse Events ---------------------------------------------------------------------------
        addListener(element, 'mousedown', ((e) => {
            if (element instanceof HTMLElement) {
                if (e.target !== element)
                    return; // Ignore events triggered on CHILDREN of the element.
                // Prevents dragging the board also selecting/highlighting text in Coordinates container
                // We can't prevent default the document input listener tho or dropdown selections can't be opened.
                e.preventDefault();
            }
            const targetPointer = pointers['mouse'];
            if (!targetPointer)
                return; // Sometimes the 'mousedown' event is fired from touch events, even though the mouse pointer does not exist.
            atleastOneInputThisFrame = true;
            const targetButton = e.button;
            updateClickInfoDown(targetButton, e);
        }));
        // This listener is placed on the document so we don't miss mouseup events if the user lifts their mouse off the element.
        addListener(document, 'mouseup', ((e) => {
            atleastOneInputThisFrame = true;
            const targetButton = e.button;
            updateClickInfoUp(targetButton, e);
        }));
        // Mouse position tracking
        addListener(element, 'mousemove', ((e) => {
            atleastOneInputThisFrame = true;
            const targetPointer = pointers['mouse'];
            if (!targetPointer)
                return; // Sometimes the 'mousemove' event is fired from touch events, even though the mouse pointer does not exist.
            targetPointer.position = getRelativeMousePosition([e.clientX, e.clientY], element);
            // console.log(`Updated pointer ${targetPointer.id} position:`, targetPointer.position);
            // Update delta (Note: e.movementX/Y are relative to the document, it should be fine)
            // Add to the current delta, in case this event is triggered multiple times in a frame.
            targetPointer.delta[0] += e.movementX;
            targetPointer.delta[1] += e.movementY;
            // Update the delta (deltaSinceDown) for simulated mouse clicks
            Object.values(Mouse).forEach((targetButton) => {
                const targetButtonInfo = clickInfo[targetButton];
                if (targetButtonInfo.deltaSinceDown) {
                    targetButtonInfo.deltaSinceDown[0] += e.movementX;
                    targetButtonInfo.deltaSinceDown[1] += e.movementY;
                }
            });
            // console.log("Mouse delta: ", targetPointer.delta);
            // Update velocity
            const now = Date.now();
            targetPointer.positionHistory.push({ pos: [...targetPointer.position], time: now }); // Deep copy the mouse position to avoid modifying the original
            recalcPointerVel(targetPointer, now);
            // console.log("Mouse relative position: ", targetPointer.position);
        }));
        // Scroll wheel tracking
        addListener(element, 'wheel', ((e) => {
            if (element instanceof HTMLElement && e.target !== element)
                return; // Ignore events triggered on CHILDREN of the element.
            atleastOneInputThisFrame = true;
            wheelDelta = e.deltaY;
            // console.log("Scroll wheel: ", wheelDelta);
        }));
        // Prevent the context menu on right click
        addListener(element, 'contextmenu', ((e) => {
            if (element instanceof Document || e.target !== element)
                return; // Allow context menu outside the element, or inside as long as the target isn't the element.
            atleastOneInputThisFrame = true;
            // console.log("Context menu");
            e.preventDefault();
        }));
        // Finger Events ---------------------------------------------------------------------------
        addListener(element, 'touchstart', ((e) => {
            if (e.target !== element)
                return; // Ignore events triggered on CHILDREN of the element.
            atleastOneInputThisFrame = true;
            // Prevent default behavior of touch events
            // Stops fingers from also triggering mouse events,
            // and prevents chrome swipe gestures.
            // This still allows the touchstart to perform default actions
            // if we interacted with an element INSIDE the element.
            if (e.target instanceof HTMLElement && e.target === element)
                e.preventDefault();
            for (let i = 0; i < e.changedTouches.length; i++) {
                const touch = e.changedTouches[i];
                const position = getRelativeMousePosition([touch.clientX, touch.clientY], element);
                pointers[touch.identifier.toString()] = {
                    isTouch: true,
                    id: touch.identifier.toString(),
                    isHeld: true,
                    position,
                    delta: [0, 0],
                    positionHistory: [{ pos: [...position], time: Date.now() }],
                    velocity: [0, 0],
                };
                // console.log("Touch start: ", touch.identifier);
                // Treat fingers as the left mouse button by default
                updateClickInfoDown(Mouse.LEFT, touch);
            }
        }));
        addListener(element, 'touchmove', ((e) => {
            atleastOneInputThisFrame = true;
            for (let i = 0; i < e.changedTouches.length; i++) {
                const touch = e.changedTouches[i];
                if (pointers[touch.identifier]) {
                    const targetPointer = pointers[touch.identifier];
                    const relativeTouchPos = getRelativeMousePosition([touch.clientX, touch.clientY], element);
                    // Update delta
                    targetPointer.delta = [
                        relativeTouchPos[0] - targetPointer.position[0],
                        relativeTouchPos[1] - targetPointer.position[1]
                    ];
                    targetPointer.position = relativeTouchPos;
                    // Update velocity
                    const now = Date.now();
                    targetPointer.positionHistory.push({ pos: [...targetPointer.position], time: now }); // Deep copy the touch position to avoid modifying the original
                    recalcPointerVel(targetPointer, now);
                    // console.log("Touch position: ", targetPointer.position);
                } // This touch likely started outside the element, so we ignored adding it.
            }
        }));
        // This listeners are placed on the document so we don't miss touchend events if the user lifts their finger off the element.
        addListener(document, 'touchend', touchEndCallback);
        addListener(document, 'touchcancel', touchEndCallback);
        function touchEndCallback(e) {
            atleastOneInputThisFrame = true;
            for (let i = 0; i < e.changedTouches.length; i++) {
                const touch = e.changedTouches[i];
                if (pointers[touch.identifier]) {
                    // console.log("Touch end/cancel: ", touch.identifier);
                    delete pointers[touch.identifier];
                } // else This touch likely started outside the element, so we ignored adding it.
                // Treat fingers as the left mouse button by default
                updateClickInfoUp(Mouse.LEFT, touch);
            }
        }
    }
    // Keyboard Events ---------------------------------------------------------------------------
    if (keyboard) {
        addListener(element, 'keydown', ((e) => {
            // if (e.target !== element) return; // Ignore events triggered on CHILDREN of the element.
            if (document.activeElement !== document.body)
                return; // This ignores the event fired when the user is typing for example in a text box.
            // console.log("Key down: ", e.code);
            atleastOneInputThisFrame = true;
            if (!keyDowns.includes(e.code))
                keyDowns.push(e.code);
            if (!keyHelds.includes(e.code))
                keyHelds.push(e.code);
            if (e.key === 'Tab')
                e.preventDefault(); // Prevents the default tabbing behavior of cycling through elements on the page.
        }));
        // This listener is placed on the document so we don't miss mouseup events if the user lifts their mouse off the element.
        addListener(element, 'keyup', ((e) => {
            // console.log("Key up: ", e.code);
            atleastOneInputThisFrame = true;
            const downIndex = keyDowns.indexOf(e.code);
            if (downIndex !== -1)
                keyDowns.splice(downIndex, 1);
            const heldIndex = keyHelds.indexOf(e.code);
            if (heldIndex !== -1)
                keyHelds.splice(heldIndex, 1);
        }));
        window.addEventListener('blur', function () {
            // Clear all keys being held, as when the window isn't in focus, we don't hear the key-up events.
            // So if we held down the shift key, then click off, then let go,
            // the game would CONTINUOUSLY keep zooming in without you pushing anything,
            // and you'd have to push the shift again to cancel it.
            keyHelds.length = 0;
        });
    }
    // Return the InputListener object ---------------------------------------------------------------------------
    return {
        element,
        atleastOneInput: () => atleastOneInputThisFrame,
        isMouseDown: (button) => clickInfo[button].isDown ?? false,
        claimMouseDown: (button) => {
            clickInfo[button].isDown = false;
            // Also remove the pointer from the list of pointers down this frame.
            const pointerId = clickInfo[button].pointerId;
            const index = pointersDown.indexOf(pointerId);
            // console.log("Claiming pointer down1: ", pointerId);
            if (index !== -1)
                pointersDown.splice(index, 1);
        },
        claimPointerDown: (pointerId) => {
            const index = pointersDown.indexOf(pointerId);
            if (index === -1)
                throw Error("Can't claim pointer down. Already claimed, or is not down.");
            // console.log("Claiming pointer down2: ", pointerId);
            pointersDown.splice(index, 1);
        },
        unclaimPointerDown: (pointerId) => {
            const index = pointersDown.indexOf(pointerId);
            if (index !== -1)
                throw Error("Can't unclaim pointer, it was never claimed.");
            pointersDown.push(pointerId);
        },
        isMouseHeld: (button) => clickInfo[button].isHeld ?? false,
        isMouseTouch: (button) => {
            const pointerId = clickInfo[button].pointerId;
            if (pointerId === undefined)
                return false;
            return pointers[pointerId]?.isTouch ?? true; // If it's delete then it must have been a touch.
        },
        getMouseId: (button) => clickInfo[button].pointerId,
        getMousePosition: (button) => {
            const pointerId = clickInfo[button].pointerId;
            if (pointerId === undefined)
                return undefined;
            /**
             * A. Pointer exists => Return its current position. (It may not exist anymore if it was a finger that has since lifted)
             * B. Pointer does not exist => Return its last known position since it simulated an UP/DOWN mouse click.
             */
            return pointers[pointerId]?.position ?? clickInfo[button].position ?? undefined;
        },
        isMouseClicked: (button) => clickInfo[button].clicked,
        isMouseDoubleClickDragged: (button) => clickInfo[button].doubleClickDrag,
        getPointerPos: (pointerId) => pointers[pointerId]?.position ?? undefined,
        getPointerDelta: (pointerId) => pointers[pointerId]?.delta ?? undefined,
        getPointerVel: (pointerId) => pointers[pointerId]?.velocity ?? undefined,
        getAllPointers: () => pointers,
        getPointerCount: () => Object.keys(pointers).length,
        getPointer: (pointerId) => pointers[pointerId],
        getPointersDown: () => pointersDown,
        getWheelDelta: () => wheelDelta,
        isKeyDown: (keyCode) => keyDowns.includes(keyCode),
        isKeyHeld: (keyCode) => keyHelds.includes(keyCode),
        removeEventListeners: () => {
            Object.keys(eventHandlers).forEach((eventType) => {
                const { target, handler } = eventHandlers[eventType];
                target.removeEventListener(eventType, handler);
            });
            console.log("Closed event listeners of Input Listener");
        }
    };
}
/**
 * Converts the mouse coordinates to be relative to the
 * element bounding box instead of absolute to the whole page.
 */
function getRelativeMousePosition(coords, element) {
    if (element instanceof Document)
        return coords; // No need to adjust if we're listening on the document.
    const rect = element.getBoundingClientRect();
    return [
        coords[0] - rect.left,
        coords[1] - rect.top
    ];
}
export { Mouse, CreateInputListener };
export default {
    getRelativeMousePosition,
};
