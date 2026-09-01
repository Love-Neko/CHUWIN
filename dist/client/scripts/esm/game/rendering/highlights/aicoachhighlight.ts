
/**
 * This script highlights the start and end squares of the move
 * the AI Coach is currently recommending.
 *
 * The two squares get different colors so it's obvious which piece to move
 * and where it's going, and neither matches the last-move highlight.
 */

import { createModel } from "../buffermodel.js";
import aicoach from "../../misc/aicoach.js";
// @ts-ignore
import shapes from "../shapes.js";


// Type Definitions -----------------------------------------------------------------------------


// @ts-ignore
import type gamefile from '../../../chess/logic/gamefile.js';


// Variables -----------------------------------------------------------------------------


/** The square the recommended piece is standing on. Amber. */
const COLOR_FROM: [number, number, number, number] = [1, 0.65, 0.1, 0.45];

/** The square it should move to. Green. */
const COLOR_TO: [number, number, number, number] = [0.15, 0.85, 0.25, 0.5];


// Functions -----------------------------------------------------------------------------


/**
 * Renders the AI Coach's recommended move, if there is one.
 *
 * Passing the gamefile lets `getSuggestion` throw out a suggestion that was
 * generated for an earlier position — so the highlight disappears by itself
 * as soon as a move is played, with no hook into the move logic needed.
 */
function render(gamefile: gamefile) {
	const suggestion = aicoach.getSuggestion(gamefile);
	if (suggestion === undefined) return;

	const data: number[] = [];

	data.push(...shapes.getTransformedDataQuad_Color_FromCoord(suggestion.from, COLOR_FROM));
	data.push(...shapes.getTransformedDataQuad_Color_FromCoord(suggestion.to, COLOR_TO));

	const model = createModel(data, 2, "TRIANGLES", true);
	model.render();
}


export default {
	render,
};
