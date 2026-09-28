import { describe, expect, it } from 'vitest';
import { hasBackendConfiguration, resolveLocalMode } from '../../../src/utils/backendConfiguration';

const complete = {
    apiBaseUrl: 'https://api.example.com',
    supabaseUrl: 'https://project.supabase.co',
    supabaseAnonKey: 'anon-key',
};

describe('hasBackendConfiguration', () => {
    it('is true when every server setting is present', () => {
        expect(hasBackendConfiguration(complete)).toBe(true);
    });

    it.each(['apiBaseUrl', 'supabaseUrl', 'supabaseAnonKey'] as const)(
        'is false when %s is missing',
        (key) => {
            expect(hasBackendConfiguration({ ...complete, [key]: '' })).toBe(false);
        },
    );
});

describe('resolveLocalMode', () => {
    it('forces local mode when the build has no server settings, even with the preference off', () => {
        expect(resolveLocalMode(false, false)).toEqual({ localMode: true, forced: true });
        expect(resolveLocalMode(undefined, false)).toEqual({ localMode: true, forced: true });
    });

    it('follows the preference when the build has server settings', () => {
        expect(resolveLocalMode(true, true)).toEqual({ localMode: true, forced: false });
        expect(resolveLocalMode(false, true)).toEqual({ localMode: false, forced: false });
        expect(resolveLocalMode('true', true)).toEqual({ localMode: false, forced: false });
    });
});
