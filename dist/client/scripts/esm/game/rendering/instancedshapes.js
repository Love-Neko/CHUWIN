/**
 * This script calculates the vertex data of a single instance
 * of several different kinds of shapes.
 *
 * Many are used for rendering legal moves, like the square, dot, or corner triangles.
 * The plus sign is used for special rights highlighting.
 *
 * The vertex data returned from any shape in this script
 * ALWAYS has a stride length of 6 (x,y, r,g,b,a)
 */
// @ts-ignore
import bufferdata from "./bufferdata.js";
// @ts-ignore
import board from "./board.js";
// @ts-ignore
import shapes from "./shapes.js";
// Variables ------------------------------------------------------------------------------
/**
 * Properties for the dots that are rendered on legal squares without an occupying piece.
 */
const DOTS = {
    /** The radius of the dots, where 1 equals the width of one square. */
    RADIUS: 0.16,
    /** How many points the edge of the dots have. */
    RESOLUTION: 32,
    /**
     * This will be added to the theme's legal move color's opacity,
     * as dots are a little less noticeable than big squares,
     * so increasing their opacity helps.
     */
    OPACITY_OFFSET: 0.2
};
/**
 * Properties for the corner triangles that are rendered on legal squares with an occupied piece,
 * they typically signify legal captures.
 */
const CORNER_TRIS = {
    /** The radius of the corner triangles, where 1 equals the width of one square. */
    TRI_WIDTH: 0.5,
    /**
     * This will be added to the theme's legal move color's opacity,
     * as the triangles are a little less noticeable than big squares,
     * so increasing their opacity helps.
     */
    OPACITY_OFFSET: 0.2
};
/**
 * Properties for the squares that make up the void ring around a bounded board.
 */
const VOIDS = {
    /**
     * How far the lit face is inset from the square's edge, where 1 equals the width of
     * one square. What's left around it is the seam, which is what makes 80 adjacent
     * voids look like 80 tiles instead of one black rectangle.
     */
    INSET: 0.055,
    /** What the face colour is multiplied by to get the seam between two voids. */
    SEAM_DARKEN: 0.55
};
/**
 * Properties for the plus sign that is rendered when the special rights highlighing
 * debug mode is enabled, next to each piece that has its special rights.
 */
const PLUS_SIGN = {
    /** Default position of the plus sign center within a square ([0,0] is square center, [0.5,0.5] is top-right corner) */
    POSITION: [0.3, 0.3], // Default: [0.3, 0.3]
    /** Length of both arms (horizontal and vertical) where 1.0 spans full square */
    ARM_LENGTH: 0.4, // Default: 0.4
    /** Width of the plus sign arms */
    EDGE_WIDTH: 0.12, // Default: 0.12
    /** Added to color alpha for better visibility */
    OPACITY_OFFSET: 0.2 // Default: 0.2
};
// Functions ------------------------------------------------------------------------------
/**
 * Generates the legal move square instance mesh, centered on [0,0]
 * @param color - The color [r, g, b, a]. This should MATCH the current theme's legal move color!
 * @returns The vertex data for the legal move square.
 */
function getDataLegalMoveSquare(color) {
    const coords = [0, 0]; // The instance is going to be at [0,0]
    // Generate and return the vertex data for the legal move square.
    return shapes.getDataQuad_Color_FromCoord(coords, color);
}
/**
 * Generates the void square instance mesh, centered on [0,0].
 *
 * Two quads, not one: a full-square quad in a darkened shade, and a slightly inset quad
 * in the given colour on top of it. The border that shows through is a seam, so a wall of
 * voids reads as tiled panels framing the board rather than as one solid black slab.
 * (Overlapping quads in a single instanced model are fine here — the plus sign already
 * does it.)
 * @param color - The face color [r, g, b, a], i.e. the theme's tint for voids.
 * @returns The vertex data for one void square.
 */
function getDataVoidSquare(color) {
    const [r, g, b, a] = color;
    const seam = [r * VOIDS.SEAM_DARKEN, g * VOIDS.SEAM_DARKEN, b * VOIDS.SEAM_DARKEN, a];
    // The instance sits at [0,0], but the square's own box is offset by the square center.
    const squareCenter = board.gsquareCenter();
    const left = -squareCenter;
    const bottom = -squareCenter;
    const right = left + 1;
    const top = bottom + 1;
    const inset = VOIDS.INSET;
    return [
        ...bufferdata.getDataQuad_Color({ left, right, bottom, top }, seam),
        ...bufferdata.getDataQuad_Color({
            left: left + inset, right: right - inset,
            bottom: bottom + inset, top: top - inset,
        }, color),
    ];
}
/**
 * Generates the legal move dot instance mesh, centered on [0,0]
 * @param color - The color [r, g, b, a]. This should MATCH the current theme's legal move color! An offset will be applied to its opacity.
 * @returns The vertex data for the "legal move dot" (circle).
 */
function getDataLegalMoveDot(color) {
    // eslint-disable-next-line prefer-const
    let [r, g, b, a] = color;
    a += DOTS.OPACITY_OFFSET; // Add the offset
    a = Math.min(a, 1); // Cap it
    const coords = [0, 0]; // The instance is going to be at [0,0]
    // The calculated dot's x & y have to be the VISUAL-CENTER of the square, not exactly at [0,0]
    const x = coords[0] + (1 - board.gsquareCenter()) - 0.5;
    const y = coords[1] + (1 - board.gsquareCenter()) - 0.5;
    // Generate and return the vertex data for the legal move dot (circle)
    return shapes.getDataCircle(x, y, DOTS.RADIUS, DOTS.RESOLUTION, r, g, b, a);
}
/**
 * Generates vertex data for four corner triangles used for legal move indicators,
 * with opacity adjustment and proper visual centering.
 * @param color - Color [r, g, b, a] from theme (opacity offset will be applied)
 * @returns Vertex data for four corner triangles
 */
function getDataLegalMoveCornerTris(color) {
    // Adjust opacity
    // eslint-disable-next-line prefer-const
    let [r, g, b, a] = color;
    a = Math.min(a + CORNER_TRIS.OPACITY_OFFSET, 1);
    // Calculate visual center position (original [0,0] instance adjusted for board centering)
    const boardCenterAdjust = (1 - board.gsquareCenter()) - 0.5;
    const centerX = boardCenterAdjust;
    const centerY = boardCenterAdjust;
    const vertices = [];
    const squareHalfSize = 0.5;
    const triHalfWidth = CORNER_TRIS.TRI_WIDTH / 2;
    // Helper to add a single corner triangle
    const addTriangle = (cornerX, cornerY, dx, dy) => {
        vertices.push(cornerX, cornerY, r, g, b, a, cornerX + dx, cornerY, r, g, b, a, cornerX, cornerY + dy, r, g, b, a);
    };
    // Generate all four corners
    addTriangle(centerX - squareHalfSize, centerY + squareHalfSize, triHalfWidth, -triHalfWidth); // Top-left
    addTriangle(centerX + squareHalfSize, centerY + squareHalfSize, -triHalfWidth, -triHalfWidth); // Top-right
    addTriangle(centerX - squareHalfSize, centerY - squareHalfSize, triHalfWidth, triHalfWidth); // Bottom-left
    addTriangle(centerX + squareHalfSize, centerY - squareHalfSize, -triHalfWidth, triHalfWidth); // Bottom-right
    return vertices;
}
/**
 * Generates vertex data for a plus sign using 5 non-overlapping rectangles
 */
function getDataPlusSign(color) {
    // eslint-disable-next-line prefer-const
    let [r, g, b, a] = color;
    a = Math.min(a + PLUS_SIGN.OPACITY_OFFSET, 1);
    const halfEdge = PLUS_SIGN.EDGE_WIDTH / 2;
    const armLength = PLUS_SIGN.ARM_LENGTH;
    const [posX, posY] = PLUS_SIGN.POSITION;
    const vertices = [];
    // Helper to add quad vertices (2 triangles)
    const addQuad = (x1, y1, x2, y2, x3, y3, x4, y4) => {
        // Triangle 1
        vertices.push(x1, y1, r, g, b, a);
        vertices.push(x2, y2, r, g, b, a);
        vertices.push(x3, y3, r, g, b, a);
        // Triangle 2
        vertices.push(x3, y3, r, g, b, a);
        vertices.push(x4, y4, r, g, b, a);
        vertices.push(x1, y1, r, g, b, a);
    };
    // Vertical arm (top segment)
    addQuad(posX - halfEdge, posY + armLength / 2, // top-left
    posX + halfEdge, posY + armLength / 2, // top-right
    posX + halfEdge, posY + halfEdge, // bottom-right
    posX - halfEdge, posY + halfEdge // bottom-left
    );
    // Vertical arm (bottom segment)
    addQuad(posX - halfEdge, posY - halfEdge, // top-left
    posX + halfEdge, posY - halfEdge, // top-right
    posX + halfEdge, posY - armLength / 2, // bottom-right
    posX - halfEdge, posY - armLength / 2 // bottom-left
    );
    // Horizontal arm (left segment)
    addQuad(posX - armLength / 2, posY + halfEdge, // top-left
    posX - halfEdge, posY + halfEdge, // top-right
    posX - halfEdge, posY - halfEdge, // bottom-right
    posX - armLength / 2, posY - halfEdge // bottom-left
    );
    // Horizontal arm (right segment)
    addQuad(posX + halfEdge, posY + halfEdge, // top-left
    posX + armLength / 2, posY + halfEdge, // top-right
    posX + armLength / 2, posY - halfEdge, // bottom-right
    posX + halfEdge, posY - halfEdge // bottom-left
    );
    // Center square
    addQuad(posX - halfEdge, posY + halfEdge, // top-left
    posX + halfEdge, posY + halfEdge, // top-right
    posX + halfEdge, posY - halfEdge, // bottom-right
    posX - halfEdge, posY - halfEdge // bottom-left
    );
    return vertices;
}
/**
 * Generates the vertex data for a single square draw with a texture, centered on [0,0]
 * @param inverted - Whether to invert the position data. Should be true if we're viewing black's perspective.
 */
function getDataTexture(inverted) {
    let { left, right, bottom, top } = shapes.getBoundingBoxOfCoord([0, 0]);
    if (inverted) {
        [left, right] = [right, left]; // Swap left and right
        [bottom, top] = [top, bottom]; // Swap bottom and top
    }
    return bufferdata.getDataQuad_Texture(left, bottom, right, top, 0, 0, 1, 1);
}
export default {
    getDataLegalMoveSquare,
    getDataVoidSquare,
    getDataLegalMoveDot,
    getDataLegalMoveCornerTris,
    getDataPlusSign,
    getDataTexture,
};
