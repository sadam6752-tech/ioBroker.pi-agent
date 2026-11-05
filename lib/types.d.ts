// Types shared by the JavaScript sources, for the type check only.

/** A voice satellite of ioBroker.assistant that asked: where to speak and to set timers. */
export interface Voice {
    /** The assistant instance, e.g. "assistant.0". */
    instance: string;
    /** Its id in the assistant, e.g. "Gast". */
    satellite: string;
    /** The state that speaks on it, e.g. "assistant.0.satellites.Gast.tts". */
    tts: string;
    /** Language it listens in, e.g. "de". */
    language?: string;
}

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
    deliverReminder?: (conversationId: unknown, text: string, voice?: Voice) => Promise<void>;
    /** The voice satellite a conversation was last asked on (ioBroker.assistant 1.4.9+). */
    voiceOf?: (conversationId: unknown) => Voice | undefined;
    /** Set a timer with a text on a voice satellite; undefined when the assistant cannot. */
    satelliteTimer?: (
        voice: Voice,
        seconds: number,
        text: string,
    ) => Promise<{ id?: unknown; fireAt?: unknown } | undefined>;
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
    /** Scripts of the javascript adapter the agent may change (lib/scripts.js). */
    scripts?: {
        /** Setting "The agent may create and change scripts". */
        allowed: () => boolean;
        /** Setting "Also change other scripts". */
        foreign: () => boolean;
        /** javascript instance of new scripts, e.g. "javascript.0". */
        instance: () => string;
        /** How long the log is watched after a start, in ms. */
        checkMs: () => number;
        /** Previous versions for revert_script. */
        history: {
            count: (id: string) => number;
            push: (id: string, source: string) => void;
            peek: (id: string) => string | undefined;
            pop: (id: string) => void;
        };
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
    /** Code mode is on: the instructions tell how to write a script. */
    codeMode?: boolean;
    /** Background jobs (lib/jobs.js). */
    jobs?: {
        create: (owner: unknown, request: any) => Promise<string>;
        list: () => object[];
        stop: (caller: unknown, id: unknown) => Promise<string>;
        resume: (caller: unknown, id: unknown) => Promise<string>;
        isJob: (conversationId: unknown) => boolean;
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
    /** Updates of adapters (lib/updates.js, main.js). */
    updates?: {
        list: (withNpm?: boolean) => Promise<{
            repositories: string[];
            checkedOnNpm?: number;
            notOnNpm?: string[];
            updates: Array<Record<string, unknown>>;
        }>;
        npm: (
            adapter: unknown,
        ) => Promise<{ adapter: string; installed: string; repository: string | null; npm: string; newer: boolean }>;
        plan: (
            adapter: unknown,
            version: unknown,
            source: unknown,
        ) => Promise<{ name: string; from: string; to: string; source: string; refusal: string }>;
        run: (
            plan: { name: string; from: string; to: string; source: string },
            conversationId: unknown,
        ) => Promise<string>;
    };
}
