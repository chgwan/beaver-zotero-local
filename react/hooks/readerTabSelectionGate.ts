/**
 * Whether the reader tab tracking in `useReaderTabSelection` may run.
 *
 * Signed-in use needs an authenticated, authorized account. Local mode has no
 * account or profile, so none of the account gates apply there. Every mode
 * waits for the library scope, since the tracking filters excluded libraries.
 */
export function canTrackReaderSelection(state: {
    localMode: boolean;
    isAuthenticated: boolean;
    hasAuthorized: boolean;
    isDeviceAuthorized: boolean;
    isLibraryAccessReady: boolean;
}): boolean {
    const hasAccountAccess = state.localMode
        || (state.isAuthenticated && state.hasAuthorized && state.isDeviceAuthorized);
    return hasAccountAccess && state.isLibraryAccessReady;
}
