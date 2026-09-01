
// Import Start
import localstorage from '../../util/localstorage.js';
import statustext from './statustext.js';
import invites from '../misc/invites.js';
import gui from './gui.js';
import guititle from './guititle.js';
import timeutil from '../../util/timeutil.js';
import docutil from '../../util/docutil.js';
import gameloader from '../chess/gameloader.js';
import aicoach from '../misc/aicoach.js';
import guiaicoach from './guiaicoach.js';
import { players } from '../../chess/util/typeutil.js';
// Import End


// Type Definitions --------------------------------------------------------------------

/** @typedef {import('../../chess/util/metadata.js').MetaData} MetaData*/

/**
 * An object containing the values of each of the invite options on the invite creation screen.
 * @typedef {Object} InviteOptions
 * @property {string} variant
 * @property {MetaData['TimeControl']} clock
 * @property {'White' | 'Black' | 'Random'} color
 * @property {'public' | 'private'} private
 * @property {'casual'} rated
 */


// Variables --------------------------------------------------------------------


"use strict";

/**
 * This script handles our Play page, containing
 * our invite creation menu.
 */

// Variables

const element_menuExternalLinks = document.getElementById('menu-external-links');

const element_PlaySelection = document.getElementById('play-selection');
const element_playName = document.getElementById('play-name');
const element_playBack = document.getElementById('play-back');
const element_local = document.getElementById('local');
const element_aiplay = document.getElementById('aiplay');
const element_createInvite = document.getElementById('create-invite');

const element_optionCardColor = document.getElementById('option-card-color');
const element_optionCardPrivate = document.getElementById('option-card-private');
const element_optionCardRated = document.getElementById('option-card-rated');
const element_optionCardClock = document.getElementById('option-card-clock');
const element_optionVariant = document.getElementById('option-variant');
const element_optionClock = document.getElementById('option-clock');
const element_optionColor = document.getElementById('option-color');
const element_optionPrivate = document.getElementById('option-private');
const element_optionRated = document.getElementById('option-rated');

const element_joinPrivate = document.getElementById('join-private');
const element_inviteCode = document.getElementById('invite-code');
const element_copyInviteCode = document.getElementById('copy-button');
const element_joinPrivateMatch = document.getElementById('join-button');
const element_textboxPrivate = document.getElementById('textbox-private');

/** Whether the play screen is open */
let pageIsOpen = false;

/** Whether we've selected a "local" or an "ai" game. @type {string} */
let modeSelected;

const indexOfInfiniteTime = 12;

/**
 * Whether the create invite button is currently locked.
 * When we create an invite, the button is disabled until we hear back from the server.
 */
let createInviteButtonIsLocked = false;
/**
 * Whether the *virtual* accept invite button is currently locked.
 * When we click invites to accept them. We have to temporarily disable
 * accepting invites so that we have spam protection and don't get the
 * "You are already in a game" server error.
 */
let acceptInviteButtonIsLocked = false;

// Functions

/**
 * Whether or not the play page is currently open, and the invites are visible.
 * @returns {boolean}
 */
function isOpen() { return pageIsOpen; }

/**
 * Returns whether we've selected a "local" or an "ai" game.
 * @returns {boolean}
 */
function getModeSelected() { return modeSelected; }

function hideElement_joinPrivate() { element_joinPrivate.classList.add('hidden'); }
function showElement_joinPrivate() { element_joinPrivate.classList.remove('hidden'); }
function hideElement_inviteCode() { element_inviteCode.classList.add('hidden'); }
function showElement_inviteCode() { element_inviteCode.classList.remove('hidden'); }

function open() {
	pageIsOpen = true;
	element_PlaySelection.classList.remove('hidden');
	element_menuExternalLinks.classList.remove('hidden');
	changePlayMode('local'); // The default now that online play is gone
	initListeners();
	invites.subscribeToInvites(); // Subscribe to the invites list subscription service!
}

function close() {
	pageIsOpen = false;
	element_PlaySelection.classList.add('hidden');
	element_menuExternalLinks.classList.add('hidden');
	hideElement_inviteCode();
	closeListeners();
	// This will auto-cancel our existing invite
	// IT ALSO clears the existing invites in the document!
	invites.unsubFromInvites();
}

function initListeners() {
	element_playBack.addEventListener('click', callback_playBack);
	element_local.addEventListener('click', callback_local);
	element_aiplay.addEventListener('click', callback_aiplay);
	element_createInvite.addEventListener('click', callback_createInvite);
	element_optionColor.addEventListener('change', callback_updateOptions);
	element_optionClock.addEventListener('change', callback_updateOptions);
	element_joinPrivateMatch.addEventListener('click', callback_joinPrivate);
	element_copyInviteCode.addEventListener('click', callback_copyInviteCode);
	element_textboxPrivate.addEventListener('keyup', callback_textboxPrivateEnter);
}

function closeListeners() {
	element_playBack.removeEventListener('click', callback_playBack);
	element_local.removeEventListener('click', callback_local);
	element_aiplay.removeEventListener('click', callback_aiplay);
	element_createInvite.removeEventListener('click', callback_createInvite);
	element_optionColor.removeEventListener('change', callback_updateOptions);
	element_optionClock.removeEventListener('change', callback_updateOptions);
	element_joinPrivateMatch.removeEventListener('click', callback_joinPrivate);
	element_copyInviteCode.removeEventListener('click', callback_copyInviteCode);
	element_textboxPrivate.removeEventListener('keyup', callback_textboxPrivateEnter);
}

/** The two mode buttons, keyed by the mode name `changePlayMode` receives. */
const modeButtons = {
	local: element_local,
	ai: element_aiplay,
};

/** Marks one mode button as selected and the rest as not-selected. */
function highlightModeButton(mode) {
	for (const [name, button] of Object.entries(modeButtons)) {
		const isSelected = name === mode;
		button.classList.toggle('selected', isSelected);
		button.classList.toggle('not-selected', !isSelected);
	}
}

function changePlayMode(mode) { // local / ai
	modeSelected = mode;
	highlightModeButton(mode);
	if (mode === 'local') {
		// Enabling the button doesn't necessarily unlock it. It's enabled for "local" so that we
		// can click "Start Game" at any point.
		// add choose col
		enableCreateInviteButton();
		element_playName.textContent = translations.menu_local;
		element_createInvite.textContent = translations.invites.start_game;
		element_optionCardColor.classList.add('hidden');
		element_optionCardRated.classList.add('hidden');
		element_optionCardPrivate.classList.add('hidden');
		element_optionCardClock.classList.remove('hidden');
		const localStorageClock = localstorage.loadItem('preferred_local_clock_invite_value');
		element_optionClock.selectedIndex = localStorageClock !== undefined ? localStorageClock : indexOfInfiniteTime; // Infinite Time
		element_joinPrivate.classList.add('hidden');
		element_inviteCode.classList.add('hidden');
	} else if (mode === 'ai') {
		// The LLM answers over the network, so a clock would be meaningless here too.
		enableCreateInviteButton();
		element_playName.textContent = translations.menu_ai;
		element_createInvite.textContent = translations.invites.start_game;
		element_optionCardColor.classList.remove('hidden');
		element_optionCardRated.classList.add('hidden');
		element_optionCardPrivate.classList.add('hidden');
		element_optionCardClock.classList.add('hidden');
		element_optionClock.selectedIndex = indexOfInfiniteTime; // Infinite Time
		element_joinPrivate.classList.add('hidden');
		element_inviteCode.classList.add('hidden');
	}
}

function callback_playBack() {
	close();
	guititle.open();
}

function callback_local() {
	changePlayMode('local');
}

function callback_aiplay() {
	changePlayMode('ai');
}

// Also starts local games
function callback_createInvite() {

	const inviteOptions = getInviteOptions();

	if (modeSelected === 'local') {
		// Load options the game loader needs to load a local loaded game
		const options = {
			Variant: inviteOptions.variant,
			TimeControl: inviteOptions.clock,
		};
		close(); // Close the invite creation screen
		gameloader.startLocalGame(options); // Actually load the game
	} else if (modeSelected === 'ai') {
		// Without an endpoint there's no opponent, so send the user to the settings instead of
		// starting a game that can never move.
		if (!aicoach.isConfigured()) {
			statustext.showStatus(aicoach.translate('needs_config', 'Enter your API URL, key and model first.'), true);
			guiaicoach.openSettings();
			return;
		}
		close(); // Close the invite creation screen
		const ourColor = inviteOptions.color !== players.NEUTRAL ? inviteOptions.color : Math.random() > 0.5 ? players.WHITE : players.BLACK;
		// Open the panel only once the game exists — it reads the gamefile as it opens.
		gameloader.startEngineGame({
			Event: `Casual AI ${translations[inviteOptions.variant]} infinite chess game`,
			Variant: inviteOptions.variant,
			youAreColor: ourColor,
			currentEngine: "aiOpponent",
			engineConfig: { engineTimeLimitPerMoveMillis: 120000 }, // Unused by the LLM, but the type requires it
			opponentName: `AI (${aicoach.getConfig().model})`,
		}).then(() => guiaicoach.open()); // The chat box is how you talk to your opponent
	}
}


/**
 * Returns an object containing the values of each of the invite options on the invite creation screen.
 * @returns {InviteOptions}
 */
function getInviteOptions() {
	const strcolor = element_optionColor.value;
	const color = strcolor === "White" ? players.WHITE :
		strcolor === "Black" ? players.BLACK :
		players.NEUTRAL;
	return {
		variant: element_optionVariant.value,
		clock: element_optionClock.value,
		color,
		private: element_optionPrivate.value,
		rated: element_optionRated.value,
	};
}

// Call whenever the Clock or Color inputs change, or play mode changes
function callback_updateOptions() {
	// Rated/private only ever mattered for online invites, so remembering the clock
	// choice is all that's left to do here.
	savePreferredClockOption(element_optionClock.selectedIndex);
}

function savePreferredClockOption(clockIndex) {
	const localOrOnline = modeSelected;
	// For search results: preferred_local_clock_invite_value preferred_online_clock_invite_value
	localstorage.saveItem(`preferred_${localOrOnline}_clock_invite_value`, clockIndex, timeutil.getTotalMilliseconds({ days: 7 }));
}

function callback_joinPrivate() {

	const code = element_textboxPrivate.value.toLowerCase();

	if (code.length !== 5) return statustext.showStatus(translations.invite_error_digits);

	element_joinPrivateMatch.disabled = true; // Re-enable when the code is changed
    
	const isPrivate = true;
	invites.accept(code, isPrivate);
}

function callback_textboxPrivateEnter() {

	// 13 is the key code for Enter key
	if (event.keyCode === 13) {
		if (!element_joinPrivateMatch.disabled) callback_joinPrivate(event);
	} else element_joinPrivateMatch.disabled = false; // Re-enable when the code is changed
}

function callback_copyInviteCode() {

	if (!modeSelected.includes('online')) return;
	if (!invites.doWeHave()) return;
    
	// Copy our private invite code.

	const code = invites.gelement_iCodeCode().textContent;
    
	docutil.copyToClipboard(code);
	statustext.showStatus(translations.invite_copied);
}

function initListeners_Invites() {
	const invites = document.querySelectorAll('.invite');

	invites.forEach(element => {
		element.addEventListener('mouseenter', callback_inviteMouseEnter);
		element.addEventListener('mouseleave', callback_inviteMouseLeave);
		element.addEventListener('click', callback_inviteClicked);
	});
}

function closeListeners_Invites() {
	const invites = document.querySelectorAll('.invite');

	invites.forEach(element => {
		element.removeEventListener('mouseenter', callback_inviteMouseEnter);
		element.removeEventListener('mouseleave', callback_inviteMouseLeave);
		element.removeEventListener('click', callback_inviteClicked);
	});
}

function callback_inviteMouseEnter() {
	event.target.classList.add('hover');

}

function callback_inviteMouseLeave() {
	event.target.classList.remove('hover');
}

function callback_inviteClicked(event) {
	invites.click(event.currentTarget);
}


/**
 * Locks the create invite button to disable it.
 * When we hear the response from the server, we will re-enable it.
 */
function lockCreateInviteButton() {
	createInviteButtonIsLocked = true;
	// ONLY ACTUALLY disabled the button if we're on the "online" screen
	if (modeSelected !== 'online') return;
	element_createInvite.disabled = true;
	// console.log('Locked create invite button.');
}

/**
 * Unlocks the create invite button to re-enable it.
 * We have heard a response from the server, and are allowed
 * to try to cancel/create an invite again.
 */
function unlockCreateInviteButton() {
	createInviteButtonIsLocked = false;
	element_createInvite.disabled = false;
	// console.log('Unlocked create invite button.');
}

function disableCreateInviteButton() { element_createInvite.disabled = true; }
function enableCreateInviteButton() { element_createInvite.disabled = false; }
function setElement_CreateInviteTextContent(text) { element_createInvite.textContent = text;  }

/**
 * Whether the Create Invite button is locked.
 * @returns {boolean}
 */
function isCreateInviteButtonLocked() { return createInviteButtonIsLocked; }

/**
 * Locks the *virtual* accept invite button to disable clicking other people's invites.
 * When we hear the response from the server, we will re-enable this.
 */
function lockAcceptInviteButton() {
	acceptInviteButtonIsLocked = true;
	// console.log('Locked accept invite button.');
}

/**
 * Unlocks the accept invite button to re-enable it.
 * We have heard a response from the server, and are allowed
 * to try to cancel/create an invite again.
 */
function unlockAcceptInviteButton() {
	acceptInviteButtonIsLocked = false;
	// console.log('Unlocked accept invite button.');
}

/**
 * Whether the *virtual* Accept Invite button is locked.
 * If it's locked, this means we temporarily cannot click other people's invites.
 * @returns {boolean}
 */
function isAcceptInviteButtonLocked() { return acceptInviteButtonIsLocked; }

/**
 * Call when the socket closes, whether or not it was unexpected.
 * This unlocks the create invite and *virtual* accept invite buttons,
 * because we can't hope to receive their reply anytime soon, which
 * replyto number is what we look for to unlock these buttons,
 * we would never be able to click them again otherwise.
 */
function onSocketClose() {
	unlockCreateInviteButton();
	unlockAcceptInviteButton();
}

export default {
	isOpen,
	hideElement_joinPrivate,
	showElement_joinPrivate,
	hideElement_inviteCode,
	showElement_inviteCode,
	getModeSelected,
	open,
	close,
	setElement_CreateInviteTextContent,
	initListeners_Invites,
	closeListeners_Invites,
	lockCreateInviteButton,
	unlockCreateInviteButton,
	isCreateInviteButtonLocked,
	lockAcceptInviteButton,
	unlockAcceptInviteButton,
	isAcceptInviteButtonLocked,
	onSocketClose,
};