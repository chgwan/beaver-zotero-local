import { beforeEach, describe, expect, it } from 'vitest';
import { handleTestPingHttpRequest } from '../../../src/services/localEndpoints/handlers/testCacheHandlers';

describe('handleTestPingHttpRequest', () => {
    beforeEach(() => {
        (Zotero as any).Beaver = {};
    });

    it('reports localMode: true when the plugin-realm local-mode flag is set', async () => {
        Zotero.Beaver.localMode = true;
        const response = await handleTestPingHttpRequest({});
        expect(response.localMode).toBe(true);
    });

    it('reports localMode: false for a hosted (non-local) instance', async () => {
        Zotero.Beaver.localMode = false;
        const response = await handleTestPingHttpRequest({});
        expect(response.localMode).toBe(false);
    });

    it('reports localMode: false when the flag is unset', async () => {
        const response = await handleTestPingHttpRequest({});
        expect(response.localMode).toBe(false);
    });
});
