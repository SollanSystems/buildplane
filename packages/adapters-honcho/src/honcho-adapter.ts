/**
 * Honcho Memory Adapter for Buildplane
 *
 * Environment variables:
 * - HONCHO_API_KEY (required) — API key from https://app.honcho.dev
 * - HONCHO_WORKSPACE_ID (optional, default: "buildplane") — Honcho workspace name
 * - BUILDPLANE_USER_ID (optional, default: "operator") — User identifier for Honcho peer
 *
 * When HONCHO_API_KEY is not set, the adapter is not loaded and Buildplane
 * operates without memory. This is the default behavior.
 */

import type { EventListener, ExecutionEvent } from "@buildplane/kernel";
import type { HonchoContextResult, HonchoPort } from "./honcho-port.js";

/**
 * Minimal subset of the Honcho SDK client used by this adapter.
 * Defined here so the adapter compiles without the SDK installed
 * (it's an optional peer dependency).
 */
interface HonchoClient {
  peer(
    id: string,
    config?: { configuration?: { observeMe?: boolean } },
  ): Promise<HonchoPeer>;
  session(id: string): Promise<HonchoSession>;
}

interface HonchoPeer {
  id: string;
  chat(query: string): Promise<string>;
  message(content: string): { peer_id: string; content: string };
}

interface HonchoSession {
  addPeers(
    peers: Array<
      [HonchoPeer, { observeMe?: boolean; observeOthers?: boolean }]
    >,
  ): Promise<void>;
  addMessages(
    messages: Array<{ peer_id: string; content: string }>,
  ): Promise<void>;
}

const DEFAULT_QUERIES: readonly string[] = [
  "What coding style and conventions does this user prefer? Be concise.",
  "What is this user's expertise level and technology stack? Be concise.",
  "What are this user's current project goals or priorities? Be concise.",
];

export interface CreateHonchoAdapterOptions {
  /** An initialized Honcho client instance. */
  readonly client: HonchoClient;
  /** The user ID for the Buildplane operator. */
  readonly userId: string;
  /** Custom default queries for context pre-fetch. */
  readonly defaultQueries?: readonly string[];
}

/**
 * Create a Honcho client from environment variables.
 * This factory lives in the adapter so the CLI never directly imports @honcho-ai/sdk.
 *
 * @throws if @honcho-ai/sdk is not installed
 */
export async function createHonchoClient(options: {
  workspaceId?: string;
  apiKey: string;
}): Promise<HonchoClient> {
  const { Honcho } = await import("@honcho-ai/sdk");
  return new Honcho({
    workspaceId: options.workspaceId ?? "buildplane",
    apiKey: options.apiKey,
    environment: "production",
  }) as unknown as HonchoClient;
}

export function createHonchoAdapter(
  options: CreateHonchoAdapterOptions,
): HonchoPort {
  const { client, userId, defaultQueries } = options;
  const queries = defaultQueries ?? DEFAULT_QUERIES;

  // Cache peers to avoid redundant API calls within a session
  let cachedUserPeer: HonchoPeer | undefined;
  let cachedAssistantPeer: HonchoPeer | undefined;

  async function getUserPeer(id: string): Promise<HonchoPeer> {
    if (cachedUserPeer && id === userId) return cachedUserPeer;
    const peer = await client.peer(id);
    if (id === userId) cachedUserPeer = peer;
    return peer;
  }

  async function getAssistantPeer(): Promise<HonchoPeer> {
    if (cachedAssistantPeer) return cachedAssistantPeer;
    cachedAssistantPeer = await client.peer("assistant", {
      configuration: { observeMe: false },
    });
    return cachedAssistantPeer;
  }

  return {
    createSubscriber(sessionId: string, subUserId: string): EventListener {
      // Pre-warm session and peers lazily on first relevant event
      let sessionReady: Promise<{
        session: HonchoSession;
        user: HonchoPeer;
        assistant: HonchoPeer;
      }> | null = null;

      async function ensureSession() {
        if (sessionReady) return sessionReady;
        sessionReady = (async () => {
          const [session, user, assistant] = await Promise.all([
            client.session(sessionId),
            getUserPeer(subUserId),
            getAssistantPeer(),
          ]);
          await session.addPeers([
            [user, { observeMe: true, observeOthers: true }],
            [assistant, { observeMe: false, observeOthers: true }],
          ]);
          return { session, user, assistant };
        })();
        return sessionReady;
      }

      return (event: ExecutionEvent) => {
        if (event.kind !== "model-response-complete") return;

        // Fire-and-forget: never let Honcho storage break the run
        void (async () => {
          try {
            const { session, assistant } = await ensureSession();
            await session.addMessages([
              assistant.message(event.text),
            ]);
          } catch {
            // Silent — follows Buildplane's event bus subscriber pattern
          }
        })();
      };
    },

    async fetchContext(
      targetUserId: string,
      customQueries?: readonly string[],
    ): Promise<HonchoContextResult> {
      const effectiveQueries = customQueries ?? queries;

      try {
        const peer = await getUserPeer(targetUserId);
        const results = await Promise.all(
          effectiveQueries.map((q) => peer.chat(q)),
        );
        return { memories: results.filter((r) => r.length > 0) };
      } catch {
        // Graceful degradation: if Honcho is unreachable, return empty
        return { memories: [] };
      }
    },
  };
}
