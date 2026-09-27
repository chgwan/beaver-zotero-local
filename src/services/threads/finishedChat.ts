import { agentRunService } from "@beaver/agent-core/transport/agentService";

export const RESPONSE_FINISH_MESSAGE = "Available when this response finishes.";

export function hasThreadWriter(threadId: string): boolean {
    return !!Zotero.Beaver?.presence
        ?.getSnapshot()
        .claims.some((claim) => claim.threadId === threadId);
}

/** A persisted terminal run alone does not establish reservation settlement. */
export async function isFinishedChat(threadId: string): Promise<boolean> {
    if (!threadId || hasThreadWriter(threadId)) return false;
    // Local mode has no server-persisted run history to settle against, and
    // the backend access policy blocks this call outright.
    if (Zotero.Beaver?.localMode === true) return false;
    try {
        const history = await agentRunService.getThreadRuns(threadId, false);
        return history.activity?.state === "idle" && !hasThreadWriter(threadId);
    } catch {
        return false;
    }
}
