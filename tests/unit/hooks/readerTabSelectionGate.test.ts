import { describe, expect, it } from 'vitest';
import { canTrackReaderSelection } from '../../../react/hooks/readerTabSelectionGate';

const signedIn = {
    localMode: false,
    isAuthenticated: true,
    hasAuthorized: true,
    isDeviceAuthorized: true,
    isLibraryAccessReady: true,
};

describe('canTrackReaderSelection', () => {
    it('tracks the reader for an authorized account', () => {
        expect(canTrackReaderSelection(signedIn)).toBe(true);
    });

    it.each(['isAuthenticated', 'hasAuthorized', 'isDeviceAuthorized'] as const)(
        'does not track the reader outside local mode when %s is false',
        (gate) => {
            expect(canTrackReaderSelection({ ...signedIn, [gate]: false })).toBe(false);
        },
    );

    it('tracks the reader in local mode, where there is no account or profile', () => {
        expect(canTrackReaderSelection({
            localMode: true,
            isAuthenticated: false,
            hasAuthorized: false,
            isDeviceAuthorized: false,
            isLibraryAccessReady: true,
        })).toBe(true);
    });

    it('waits for library access in every mode', () => {
        expect(canTrackReaderSelection({ ...signedIn, isLibraryAccessReady: false })).toBe(false);
        expect(canTrackReaderSelection({
            localMode: true,
            isAuthenticated: false,
            hasAuthorized: false,
            isDeviceAuthorized: false,
            isLibraryAccessReady: false,
        })).toBe(false);
    });
});
