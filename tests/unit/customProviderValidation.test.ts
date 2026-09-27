/**
 * Endpoint validation for custom providers.
 *
 * Two callers share one parser: the hosted path (hidden behind
 * `validateCustomProviderApiBase`) mirrors the backend's SSRF protection —
 * HTTPS only, no loopback or private hosts, because Beaver's own backend makes
 * the request. Local mode makes the request from the user's own machine, so
 * `validateProviderApiBase(url, { allowLocalEndpoints: true })` allows plain
 * HTTP and loopback/private hosts, while still rejecting a non-http(s)
 * protocol or a URL that fails to parse.
 */
import { describe, expect, it } from 'vitest';
import {
    validateCustomProviderApiBase,
    validateProviderApiBase,
} from '@beaver/agent-core/types/customChatModel';

describe('validateProviderApiBase', () => {
    it('accepts a localhost endpoint when local endpoints are allowed', () => {
        expect(validateProviderApiBase('http://localhost:11434/v1', { allowLocalEndpoints: true })).toEqual({
            valid: true,
        });
    });

    it('accepts a private-range endpoint when local endpoints are allowed', () => {
        expect(validateProviderApiBase('http://192.168.1.10:8080/v1', { allowLocalEndpoints: true })).toEqual({
            valid: true,
        });
    });

    it('rejects a localhost endpoint when local endpoints are not allowed', () => {
        const result = validateProviderApiBase('http://localhost:11434/v1', { allowLocalEndpoints: false });
        expect(result.valid).toBe(false);
    });

    it('rejects a non-http(s) protocol even when local endpoints are allowed', () => {
        const result = validateProviderApiBase('ftp://example.com', { allowLocalEndpoints: true });
        expect(result.valid).toBe(false);
    });

    it('rejects a URL that does not parse when local endpoints are allowed', () => {
        const result = validateProviderApiBase('not a url', { allowLocalEndpoints: true });
        expect(result.valid).toBe(false);
    });

    it('rejects a URL that does not parse when local endpoints are not allowed', () => {
        const result = validateProviderApiBase('not a url', { allowLocalEndpoints: false });
        expect(result.valid).toBe(false);
    });

    it('accepts a public https endpoint regardless of the local-endpoints option', () => {
        expect(validateProviderApiBase('https://openrouter.ai/api/v1', { allowLocalEndpoints: true })).toEqual({
            valid: true,
        });
        expect(validateProviderApiBase('https://openrouter.ai/api/v1', { allowLocalEndpoints: false })).toEqual({
            valid: true,
        });
    });
});

describe('validateCustomProviderApiBase (hosted path, unchanged)', () => {
    it('rejects a localhost endpoint', () => {
        const result = validateCustomProviderApiBase('http://localhost:11434/v1');
        expect(result.valid).toBe(false);
    });

    it('matches validateProviderApiBase with allowLocalEndpoints: false exactly', () => {
        const inputs = [
            'http://localhost:11434/v1',
            'https://api.example.com/v1',
            'http://192.168.1.10:8080/v1',
            '',
            undefined,
            'not a url',
        ];
        for (const input of inputs) {
            expect(validateCustomProviderApiBase(input)).toEqual(
                validateProviderApiBase(input, { allowLocalEndpoints: false }),
            );
        }
    });

    it('still requires HTTPS for a public host', () => {
        const result = validateCustomProviderApiBase('http://api.example.com/v1');
        expect(result.valid).toBe(false);
        expect(result.error).toMatch(/HTTPS/);
    });

    it('accepts a valid hosted endpoint', () => {
        expect(validateCustomProviderApiBase('https://openrouter.ai/api/v1')).toEqual({ valid: true });
    });
});
