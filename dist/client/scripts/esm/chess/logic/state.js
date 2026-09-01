/**
 * This script creates, queues, and applies gamefile states
 * to the gamefile when a Move is created, and executed.
 */
// Creating Local State Changes --------------------------------------------------------------------
/** Creates a check local StateChange, adding it to the Move and immediately applying it to the gamefile. */
function createCheckState(move, current, future, gamestate) {
    const newStateChange = { type: 'check', current, future };
    move.state.local.push(newStateChange); // Check is a local state
    // Check states are immediately applied to the gamefile
    applyLocalState(gamestate.local, newStateChange, true);
}
/** Creates an attackers local StateChange, adding it to the Move and immediately applying it to the gamefile. */
function createAttackersState(move, current, future, gamestate) {
    const newStateChange = { type: 'attackers', current, future };
    move.state.local.push(newStateChange); // Attackers is a local state
    // Attackers states are immediately applied to the gamefile
    applyLocalState(gamestate.local, newStateChange, true);
}
// Creating Global State Changes --------------------------------------------------------------------
/** Creates an enpassant global StateChange, queueing it by adding it to the Move. */
function createEnPassantState(move, current, future) {
    if (current === future)
        return; // If the current and future values are identical, we can skip queueing this state.
    const newStateChange = { type: 'enpassant', current, future };
    // Check to make sure there isn't already an enpassant state change,
    // If so, we need to overwrite that one's future value, instead of queueing a new one.
    const preExistingEnPassantState = move.state.global.find(state => state.type === 'enpassant');
    if (preExistingEnPassantState !== undefined)
        preExistingEnPassantState.future = future;
    else
        move.state.global.push(newStateChange); // EnPassant is a global state
}
/** Creates a specialrights global StateChange, queueing it by adding it to the Move. */
function createSpecialRightsState(move, coordsKey, current, future) {
    if (current === future)
        return; // If the current and future values are identical, we can skip queueing this state.
    const newStateChange = { type: 'specialrights', current, future, coordsKey };
    move.state.global.push(newStateChange); // Special Rights is a global state
}
/** Creates a moverule global StateChange, queueing it by adding it to the Move. */
function createMoveRuleState(move, current, future) {
    if (current === future)
        return; // If the current and future values are identical, we can skip queueing this state.
    const newStateChange = { type: 'moverulestate', current, future };
    move.state.global.push(newStateChange); // Special Rights is a global state
}
// Applying State Changes ----------------------------------------------------------------------------
/**
 * Applies all the StateChanges of a Move, in order, to the gamefile,
 * whether forward or backward, local or global.
 */
function applyMove(gamestate, moveState, 
/** Whether we're playing this move forward or backward. */
forward, 
/**
 * Specify `globalChange` as true if you are making a physical move in the game,
 * or rewinding a simulated move.
 * All other situations, such as rewinding and forwarding the game, should only
 * be local, so `globalChange` should be false.
 */
{ globalChange = false } = {}) {
    applyLocalStateChanges(gamestate.local, moveState.local, forward);
    if (globalChange)
        applyGlobalStateChanges(gamestate.global, moveState.global, forward);
}
function applyLocalStateChanges(gamestate, changes, forward) {
    for (const state of changes) {
        applyLocalState(gamestate, state, forward);
    }
}
function applyGlobalStateChanges(gamestate, changes, forward) {
    for (const state of changes) {
        applyGlobalState(gamestate, state, forward);
    }
}
/** Applies a move's local state change to the gamefile, forward or backward. */
function applyLocalState(gamestate, state, forward) {
    const noNewValue = (forward ? state.future : state.current) === undefined;
    switch (state.type) {
        case 'check':
            gamestate.inCheck = forward ? state.future : state.current;
            break;
        case 'attackers':
            if (noNewValue)
                gamestate.attackers = [];
            else
                gamestate.attackers = forward ? state.future : state.current;
            break;
        default:
            throw new Error(`State ${state.type} is not a local state change.`);
    }
}
/** Applies a move's global state change to the gamefile, forward or backward. */
function applyGlobalState(gamestate, state, forward) {
    const noNewValue = (forward ? state.future : state.current) === undefined;
    switch (state.type) {
        case 'specialrights':
            if (!(forward ? state.future : state.current))
                gamestate.specialRights.delete(state.coordsKey);
            else
                gamestate.specialRights.add(state.coordsKey);
            break;
        case 'enpassant':
            if (noNewValue)
                delete gamestate.enpassant;
            else
                gamestate.enpassant = forward ? state.future : state.current;
            break;
        case 'moverulestate':
            gamestate.moveRuleState = forward ? state.future : state.current;
            break;
        default:
            throw new Error(`State ${state.type} is not a global state change.`);
    }
}
// Exports --------------------------------------------------------------------------
export default {
    applyMove,
    applyGlobalStateChanges,
    createCheckState,
    createAttackersState,
    createEnPassantState,
    createSpecialRightsState,
    createMoveRuleState,
};
