
/**
 * This module configures the middleware waterfall of our server
 */

import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';

// Middleware
import cookieParser from 'cookie-parser';
import credentials from './credentials.js';
import secureRedirect from './secureRedirect.js';
import errorHandler from './errorHandler.js';
import { logger } from './logEvents.js';
import { verifyJWT } from './verifyJWT.js';
import { rateLimit } from './rateLimit.js';

// External translation middleware
import i18next from 'i18next';
import middleware from 'i18next-http-middleware';

// Other imports
import { useOriginWhitelist } from '../config/config.js';
import { router as rootRouter } from '../routes/root.js';
import send404 from './send404.js';
import corsOptions from '../config/corsOptions.js';

import { fileURLToPath } from 'node:url';
import { accessTokenIssuer } from '../controllers/authenticationTokens/accessTokenIssuer.js';
import { verifyAccount } from '../controllers/verifyAccountController.js';
import { requestConfirmEmail } from '../controllers/sendMail.js';
import { getMemberData } from '../api/Member.js';
import { handleLogout } from '../controllers/logoutController.js';
import { postPrefs, setPrefsCookie } from '../api/Prefs.js';
import { postCheckmateBeaten, setPracticeProgressCookie } from '../api/PracticeProgress.js';
import { handleLogin } from '../controllers/loginController.js';
import { checkEmailValidity, checkUsernameAvailable, createNewMember } from '../controllers/createAccountController.js';
import { removeAccount } from '../controllers/deleteAccountController.js';
import { assignOrRenewBrowserID } from '../controllers/browserIDManager.js';
import { processCommand } from "../api/AdminPanel.js";
import { postAICoach, getAICoachPersona } from '../api/AICoach.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Configures the Middleware Waterfall
 * 
 * app.use adds the provided function to EVERY SINGLE router and incoming connection.
 * Each middleware function must call next() to go to the next middleware.
 * Connections that do not pass one middleware will not continue.
 * 
 * @param {object} app - The express application instance.
 */
function configureMiddleware(app) {

	// Note: requests that are rate limited will not be logged, to mitigate slow-down during a DDOS.
	app.use(rateLimit);

	/**
	 * AI Coach proxy. Registered HERE, before the global json parser below, for two reasons:
	 * 1. A position description + prompt easily exceeds the global 10kb limit, so this route
	 *    needs its own, larger parser. express.json() short-circuits once a body has been
	 *    parsed, so ours has to run first.
	 * 2. It also lands above app.use(logger), so the request body — which carries the user's
	 *    API key — is never written to the request log.
	 *
	 * This route is deliberately unauthenticated because it is meant for a local, single-user
	 * install. If you ever expose this server to a LAN or the internet, add authentication and
	 * rate limiting here, or you have published an anonymous LLM gateway on someone else's key.
	 */
	app.post('/api/ai-coach', express.json({ limit: '1mb' }), postAICoach);

	// This allows us to retrieve json-received-data as a parameter/data!
	// The logger can't log the request body without this
	app.use(express.json({ limit: '10kb' })); // Limit the size to avoid parsing excessively large objects. Beyond this should throw an error caught by our error handling middleware.

	app.use(logger); // Log the request

	// Security Headers & HTTPS Enforcement
	app.use(secureRedirect); // Redirects http to secure https
	app.use(helmet({
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'", "'unsafe-inline'"],  // Allows inline scripts
				scriptSrcAttr: ["'self'", "'unsafe-inline'"],  // Allows inline event handlers
				objectSrc: ["'none'"],
				imgSrc: ["'self'", "data:"]
			},
		},
	}));

	// Path Traversal Protection, and error protection from malformed URLs
	app.use((req, res, next) => {
		try {
			const decoded = decodeURIComponent(req.url);
			
			// Check 1: Raw encoded patterns (before decoding)
			const encodedPatterns = /(%2e%2e|%252e|%%32%65)/gi;
			if (encodedPatterns.test(req.url)) {
				console.warn('Blocked traversal:', req.url);
				console.warn('Decoded URL:', decoded);
				return res.status(403).send('Forbidden');
			}

			// Check 2: Decoded path segments
			const segments = decoded.split(/[\\/]/);
			if (segments.includes('..')) {
				// Console warn both the decoded and the original URL
				console.warn('Blocked traversal:', req.url);
				console.warn('Decoded URL:', decoded);
				return res.status(403).send('Forbidden');
			}

			next();
		// eslint-disable-next-line no-unused-vars
		} catch (err) {
			console.warn('Blocked invalid URL encoding:', req.url); 
			res.status(400).send('Invalid URL encoding');
		}
	});

	app.use(credentials); // Handle credentials check. Must be before CORS.

	/** This sets req.i18n, and req.i18n.resolvedLanguage */
	app.use(middleware.handle(i18next, { removeLngFromUrl: false }));

	/**
     * Cross Origin Resource Sharing
     * 
     * This allows 3rd party middleware. Without this, other sites will get an
     * error when retreiving data on your site to serve to their customers.
     * Be careful, incorrectly setting will block our own customers.
     * For many applications though, you don't want it open to the public,
     * but perhaps you do want search engines to have access?
     * 
     * Does this create a 'Access-Control-Allow-Origin' header?
     */
	const options = useOriginWhitelist ? corsOptions : undefined;
	app.use(cors(options));

	/**
     * Allow processing urlencoded (FORM) data so that we can retrieve it as a parameter/variable.
     * (e.g. when the content-type header is 'application/x-www-form-urlencoded')
     */
	app.use(express.urlencoded({ limit: '10kb', extended: false })); // Limit the size to avoid parsing excessively large objects

	// Sets the req.cookies property
	app.use(cookieParser());

	// Serve public assets. (e.g. css, scripts, images, audio)
	app.use(express.static(path.join(__dirname, '../../client'))); // Serve public assets

	/**
	 * The win / loss easter egg's picture and song, which live in the project's own
	 * `yinpin/` folder rather than in `src/client`.
	 *
	 * Served from where the user keeps them for two reasons: `build.js` wipes and refills
	 * `dist` on every build, so anything under `src/client` is copied again each time —
	 * these are megabytes of media — and swapping a picture or a song here takes effect
	 * on a refresh instead of a rebuild. Read-only, and media files only.
	 */
	app.use('/yinpin', express.static(path.join(__dirname, '../../../yinpin')));

	// Every request beyond this point will not be for a resource like a script or image,
	// but it will be a request for an HTML or API

	// Directory required for the ACME (Automatic Certificate Management Environment) protocol used by Certbot to validate your domain ownership.
	app.use('/.well-known/acme-challenge', express.static(path.join(__dirname, '../../../cert/.well-known/acme-challenge')));

	// This sets the 'browser-id' cookie on every request for an HTML file
	app.use(assignOrRenewBrowserID);
	// This sets the user 'preferences' cookie on every request for an HTML file
	app.use(setPrefsCookie);
	// This sets the user 'checkmates_beaten' cookie on every request for an HTML file
	app.use(setPracticeProgressCookie);

	// Provide a route

	// Root router
	app.use('/', rootRouter); // Contains every html page.

	// Account router
	app.post('/createaccount', createNewMember); // "/createaccount" POST request
	app.get('/createaccount/username/:username', checkUsernameAvailable);
	app.get('/createaccount/email/:email', checkEmailValidity);

	// Member router
	app.delete('/member/:member/delete', removeAccount);


	// API --------------------------------------------------------------------

	app.post("/auth", handleLogin); // Login fetch POST request

	app.post("/setlanguage", (req, res) => { // Language cookie setter POST request
		res.cookie("i18next", req.i18n.resolvedLanguage);
		res.send(""); // Doesn't work without this for some reason
	});

	/**
	 * The AI Coach persona the user keeps in `tsc.md` at the project root.
	 *
	 * Unlike the POST above, this one carries no request body and no API key, so it wants
	 * nothing special from the waterfall and sits down here with the other API routes,
	 * where it gets the normal logging and security headers.
	 */
	app.get('/api/ai-coach/persona', getAICoachPersona);

	// Token Authenticator -------------------------------------------------------

	/**
     * Sets the req.memberInfo properties if they have an authorization
     * header (contains access token) or refresh cookie (contains refresh token).
     * Don't send unauthorized people private stuff without the proper role.
	 * 
	 * PLACE AS LOW AS YOU CAN, BUT ABOVE ALL ROUTES THAT NEED AUTHENTICATION!!
	 * This requires database requests.
     */
	app.use(verifyJWT);

	// ROUTES THAT NEED AUTHENTICATION ------------------------------------------------------

	app.post("/api/get-access-token", accessTokenIssuer);

	app.post('/api/set-preferences', postPrefs);

	app.post('/api/update-checkmatelist', postCheckmateBeaten);

	app.get("/logout", handleLogout);

	app.get("/command/:command", processCommand);

	// Member routes that do require authentication
	app.get('/member/:member/data', getMemberData);
	app.get('/member/:member/send-email', requestConfirmEmail);
	app.get("/verify/:member/:code", verifyAccount);

	// Last Resort 404 and Error Handler ----------------------------------------------------

	// If we've reached this point, send our 404 page.
	app.all('*', send404);

	// Custom error handling. Comes after 404.
	app.use(errorHandler);
}

export default configureMiddleware;
