import { describe, expect, it, vi } from 'vitest';

import ConnectionManager from './connectionManager';

describe('ConnectionManager injected message context', () => {
    it('forwards a current producer context unchanged', () => {
        const client = { handleMessageReceived: vi.fn() };
        const manager = { getApiClient: () => client };
        const context = Object.freeze({ isCurrent: () => true });
        const message = { ServerId: 'server-a', Data: '{"Id":"item-a"}' };

        ConnectionManager.prototype.handleMessageReceived.call(manager, message, context);

        expect(client.handleMessageReceived).toHaveBeenCalledWith(
            { ServerId: 'server-a', Data: { Id: 'item-a' } }, context
        );
    });

    it('rejects a stale producer before parsing or forwarding', () => {
        const client = { handleMessageReceived: vi.fn() };
        const manager = { getApiClient: vi.fn(() => client) };
        const context = { isCurrent: () => false };
        const message = { ServerId: 'server-a', Data: '{"Id":"item-a"}' };

        ConnectionManager.prototype.handleMessageReceived.call(manager, message, context);

        expect(manager.getApiClient).not.toHaveBeenCalled();
        expect(client.handleMessageReceived).not.toHaveBeenCalled();
        expect(message.Data).toBe('{"Id":"item-a"}');
    });

    it('retains the legacy one-argument forwarder for fork admission', () => {
        const client = { handleMessageReceived: vi.fn() };
        const manager = { getApiClient: () => client };
        const message = { ServerId: 'server-a', Data: { Id: 'item-a' } };

        ConnectionManager.prototype.handleMessageReceived.call(manager, message);

        expect(client.handleMessageReceived).toHaveBeenCalledWith(message, undefined);
    });
});
