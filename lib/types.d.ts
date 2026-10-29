// Types shared by the JavaScript sources, for the type check only.

/** What the tools read from the adapter at every use, and the adapter functions they call back into. */
export interface Policy {
    /** States the agent may write. */
    allowlist: RegExp[];
    /** States whose write the user must confirm first (missing: none). */
    confirmList?: RegExp[];
    /** Log writes instead of executing them. */
    dryRun: boolean;
    /** IANA time zone of the house, e.g. "Europe/Berlin". */
    timeZone?: string;
    /** Extra instructions of the user. */
    instructions: string;
    /** Ask the user; resolves to "yes", "no", "timeout" or "unavailable". */
    requestConfirmation?: (request: {
        conversationId: unknown;
        id: string;
        val: unknown;
        action?: string;
    }) => Promise<string>;
    /** Send a reminder that is due. */
    deliverReminder?: (conversationId: unknown, text: string) => Promise<void>;
    /** History instance to query, or "". */
    historyInstance?: () => Promise<string>;
    /** Instances with "Restart allowed", e.g. "telegram.0". */
    restartList?: string[];
    /** Restart an instance and wait until it runs again; resolves to a text for the model. */
    restartInstance?: (instance: string) => Promise<string>;
    /** The long-term memory shared by all conversations. */
    memory?: {
        enabled: () => boolean;
        list: () => Array<{ id: string; text: string; ts: number }>;
        add: (fact: string) => Promise<string>;
        remove: (query: string) => Promise<string>;
    };
    /** Watches of notify_when (lib/watches.js). */
    watches?: {
        add: (request: {
            conversationId: unknown;
            stateId: string;
            condition: string;
            value?: unknown;
            minutes?: number;
            text: string;
        }) => Promise<string>;
        list: (conversationId: unknown) => Array<{
            id: string;
            stateId: string;
            condition: string;
            value: unknown;
            forMs: number;
            text: string;
            until: number;
        }>;
        cancel: (conversationId: unknown, id: string) => Promise<boolean>;
    };
    /** Reminders and scheduled writes of a conversation (live tasks of the harness). */
    scheduled?: {
        tasks: (
            conversationId: unknown,
        ) => Promise<Array<{ id: string; kind: string; at: number; [key: string]: unknown }>>;
        cancel: (conversationId: unknown, id: string) => Promise<boolean>;
    };
    /** Path of the ioBroker log file, or null. */
    logFile?: () => string | null;
    /** Enabled instances of the scheduler adapter fullcalendar, e.g. ["fullcalendar.0"]. */
    schedulers?: () => string[];
}
