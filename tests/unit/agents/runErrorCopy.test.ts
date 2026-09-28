/**
 * Unit tests for `@beaver/agent-core/run-state/runErrorCopy`.
 */

import { describe, expect, it } from 'vitest';

import { getRunErrorTitle, stripRunErrorTypePrefix } from '@beaver/agent-core/run-state/runErrorCopy';

describe('getRunErrorTitle', () => {
    it('maps known error types to the in-chat header titles', () => {
        expect(getRunErrorTitle('usage_limit_exceeded')).toBe('Limit Reached');
        expect(getRunErrorTitle('connection_error')).toBe('Connection Failed');
    });

    it('falls back for unknown types', () => {
        expect(getRunErrorTitle('regeneration_error')).toBe('An error occurred');
        expect(getRunErrorTitle(undefined)).toBe('An error occurred');
    });

    it('maps local-mode error types to legible titles', () => {
        expect(getRunErrorTitle('local_config_error')).toBe('Model not configured');
        expect(getRunErrorTitle('local_agent_error')).toBe('Local agent error');
        expect(getRunErrorTitle('local_provider_auth')).toBe('API key rejected');
        expect(getRunErrorTitle('local_provider_rate_limit')).toBe('Rate limited by provider');
        expect(getRunErrorTitle('local_provider_network')).toBe('Provider unreachable');
        expect(getRunErrorTitle('local_provider_not_found')).toBe('Model or endpoint not found');
        expect(getRunErrorTitle('local_provider_bad_request')).toBe('Provider rejected the request');
        expect(getRunErrorTitle('local_provider_server')).toBe('Provider error');
    });
});

describe('stripRunErrorTypePrefix', () => {
    it('removes a leading error-type prefix the header already shows', () => {
        expect(stripRunErrorTypePrefix('internal_error: something broke', 'internal_error')).toBe(
            'something broke',
        );
    });

    it('leaves a message without that prefix untouched', () => {
        expect(stripRunErrorTypePrefix('something broke', 'internal_error')).toBe('something broke');
        expect(stripRunErrorTypePrefix('internal_error:no space', 'internal_error')).toBe(
            'internal_error:no space',
        );
        expect(stripRunErrorTypePrefix('other_error: something broke', 'internal_error')).toBe(
            'other_error: something broke',
        );
    });

    it('returns the message unchanged when there is no error type', () => {
        expect(stripRunErrorTypePrefix('internal_error: something broke', undefined)).toBe(
            'internal_error: something broke',
        );
    });
});
