/**
 * Whether this plugin instance runs in local mode.
 *
 * Local mode is fixed for the plugin's lifetime: the plugin reads the
 * `localMode` preference once at startup and publishes it as
 * `Zotero.Beaver.localMode`, and the account and the backend access policy
 * are both built from that value. The renderer derives from the same flag so
 * it can never disagree with them; toggling the preference takes effect after
 * a restart.
 *
 * Kept free of other imports: the account, profile and chat-access atoms all
 * read it.
 */

import { atom } from 'jotai';

/** The user id stamped on runs in local mode, where there is no account. */
export const LOCAL_USER_ID = 'local';

/** Whether this plugin instance runs in local mode. */
export function isLocalMode(): boolean {
    return Zotero.Beaver?.localMode === true;
}

/** Whether this plugin instance runs in local mode. Fixed at startup. */
export const localModeEnabledAtom = atom<boolean>(() => isLocalMode());

/**
 * Whether local mode is on because this build has no Beaver server settings,
 * so the preference cannot switch it off.
 */
export function isLocalModeForced(): boolean {
    return Zotero.Beaver?.localModeForced === true;
}

/** Whether local mode is forced by the build. Fixed at startup. */
export const localModeForcedAtom = atom<boolean>(() => isLocalModeForced());
