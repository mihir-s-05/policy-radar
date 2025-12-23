/**
 * Cancellation registry for managing active streaming requests.
 * Allows frontend to cancel ongoing backend operations.
 */

// Map of session ID to AbortController
const activeRequests = new Map<string, AbortController>();

/**
 * Register a new cancellable request for a session.
 * If there's already an active request for this session, it will be cancelled first.
 */
export function registerRequest(sessionId: string): AbortController {
    // Cancel any existing request for this session
    const existing = activeRequests.get(sessionId);
    if (existing) {
        existing.abort();
    }

    const controller = new AbortController();
    activeRequests.set(sessionId, controller);
    return controller;
}

/**
 * Cancel an active request for a session.
 * Returns true if a request was cancelled, false if no active request exists.
 */
export function cancelRequest(sessionId: string): boolean {
    const controller = activeRequests.get(sessionId);
    if (controller) {
        controller.abort();
        activeRequests.delete(sessionId);
        return true;
    }
    return false;
}

/**
 * Remove a request from the registry (call after completion).
 */
export function unregisterRequest(sessionId: string): void {
    activeRequests.delete(sessionId);
}

/**
 * Check if a request is currently active for a session.
 */
export function hasActiveRequest(sessionId: string): boolean {
    return activeRequests.has(sessionId);
}

/**
 * Get the abort signal for a session's active request.
 */
export function getSignal(sessionId: string): AbortSignal | undefined {
    return activeRequests.get(sessionId)?.signal;
}
