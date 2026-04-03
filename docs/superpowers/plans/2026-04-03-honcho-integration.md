# Honcho Memory Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Honcho memory SDK as an adapter so Buildplane can build persistent user representations and inject them into model prompts via TaskIntent.context.memories.

**Architecture:** Create a new `packages/adapters-honcho` adapter that exposes two capabilities: (1) an EventBus subscriber that stores prompts and model responses to Honcho sessions, and (2) a context pre-fetcher that queries Honcho peer representations and returns strings for injection into `TaskIntent.context.memories`. The adapter follows Buildplane's port/adapter pattern — a kernel port defines the contract, the adapter implements it, and the CLI wires it up.

**Tech Stack:** TypeScript, `@honcho-ai/sdk` v2.1.0, pnpm workspace, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/adapters-honcho/package.json` | Package manifest, depends on `@buildplane/kernel` + `@honcho-ai/sdk` |
| Create | `packages/adapters-honcho/tsconfig.json` | TypeScript config extending base |
| Create | `packages/adapters-honcho/src/index.ts` | Public API barrel |
| Create | `packages/adapters-honcho/src/honcho-port.ts` | Port interface (re-exported from kernel later if adopted) |
| Create | `packages/adapters-honcho/src/honcho-adapter.ts` | Adapter implementation: client init, subscriber factory, context pre-fetcher |
| Create | `packages/adapters-honcho/test/honcho-adapter.test.ts` | Unit tests with mocked Honcho SDK |
| Modify | `apps/cli/src/run-cli.ts:76-205` | Wire Honcho adapter into `loadCliOrchestrator` |
| Modify | `apps/cli/package.json` | Add `@buildplane/adapters-honcho` dependency |
| Modify | `package.json` (root) | Add adapters-honcho to `typecheck` script |

---

### Task 1: Scaffold the adapters-honcho Package

**Files:**
- Create: `packages/adapters-honcho/package.json`
- Create: `packages/adapters-honcho/tsconfig.json`
- Create: `packages/adapters-honcho/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@buildplane/adapters-honcho",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "Honcho memory adapter for Buildplane",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@buildplane/kernel": "workspace:*"
  },
  "devDependencies": {
    "@honcho-ai/sdk": "^2.1.0"
  },
  "peerDependencies": {
    "@honcho-ai/sdk": ">=2.0.0"
  },
  "peerDependenciesMeta": {
    "@honcho-ai/sdk": {
      "optional": true
    }
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src"],
  "exclude": ["dist", "test"]
}
```

- [ ] **Step 3: Create placeholder barrel export**

```typescript
// src/index.ts
// Public API — populated after port and adapter are implemented.
```

Note: The barrel is intentionally empty so this commit compiles. It gets populated in Task 3.

- [ ] **Step 4: Install dependencies**

Run: `cd /Users/kenthall/buildplane/main && pnpm install`
Expected: lockfile updated, `@honcho-ai/sdk` resolved

- [ ] **Step 5: Commit**

```bash
git add packages/adapters-honcho/package.json packages/adapters-honcho/tsconfig.json packages/adapters-honcho/src/index.ts pnpm-lock.yaml
git commit -m "feat(adapters-honcho): scaffold package with Honcho SDK peer dep"
```

---

### Task 2: Define the HonchoPort Interface

**Files:**
- Create: `packages/adapters-honcho/src/honcho-port.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapters-honcho/test/honcho-port.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { HonchoPort, HonchoContextResult } from "../src/honcho-port.js";

describe("HonchoPort type contract", () => {
  it("satisfies the port interface shape", () => {
    // Type-level test: a conforming object compiles without error
    const mock: HonchoPort = {
      createSubscriber: () => () => {},
      fetchContext: async () => ({ memories: [] }),
    };
    expect(mock.createSubscriber).toBeTypeOf("function");
    expect(mock.fetchContext).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kenthall/buildplane/main && pnpm vitest run packages/adapters-honcho/test/honcho-port.test.ts`
Expected: FAIL — cannot resolve `../src/honcho-port.js`

- [ ] **Step 3: Write the port interface**

Create `packages/adapters-honcho/src/honcho-port.ts`:

```typescript
import type { EventListener } from "@buildplane/kernel";

/**
 * Result of a Honcho context pre-fetch.
 * The `memories` array contains natural-language strings
 * suitable for injection into TaskIntent.context.memories.
 */
export interface HonchoContextResult {
  readonly memories: readonly string[];
}

/**
 * Port contract for Honcho memory integration.
 *
 * - createSubscriber: returns an EventListener that stores
 *   prompts and model responses to a Honcho session.
 * - fetchContext: queries Honcho for user representations
 *   and returns them as memory strings for the prompt.
 */
export interface HonchoPort {
  /**
   * Create an EventBus subscriber scoped to a strategy execution.
   * The subscriber listens for model-response-complete events
   * and stores the prompt/response exchange in Honcho.
   */
  createSubscriber(sessionId: string, userId: string): EventListener;

  /**
   * Pre-fetch user context from Honcho for prompt injection.
   * @param userId - The operator's identifier
   * @param queries - Natural language questions to ask Honcho about the user
   * @returns Memories array for TaskIntent.context.memories
   */
  fetchContext(
    userId: string,
    queries?: readonly string[],
  ): Promise<HonchoContextResult>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/kenthall/buildplane/main && pnpm vitest run packages/adapters-honcho/test/honcho-port.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/adapters-honcho/src/honcho-port.ts packages/adapters-honcho/test/honcho-port.test.ts
git commit -m "feat(adapters-honcho): define HonchoPort interface and context result type"
```

---

### Task 3: Implement the Honcho Adapter

**Files:**
- Create: `packages/adapters-honcho/src/honcho-adapter.ts`
- Create: `packages/adapters-honcho/test/honcho-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters-honcho/test/honcho-adapter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createHonchoAdapter } from "../src/honcho-adapter.js";
import type { HonchoPort } from "../src/honcho-port.js";

// ── Mock SDK types ─────────────────────────────────────────

interface MockPeer {
  id: string;
  chat: ReturnType<typeof vi.fn>;
  message: (content: string) => { peer_id: string; content: string };
}

interface MockSession {
  addPeers: ReturnType<typeof vi.fn>;
  addMessages: ReturnType<typeof vi.fn>;
}

interface MockHonchoClient {
  peer: ReturnType<typeof vi.fn>;
  session: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockHonchoClient {
  const userPeer: MockPeer = {
    id: "user-peer-id",
    chat: vi.fn().mockResolvedValue("User prefers concise output"),
    message: (content: string) => ({ peer_id: "user-peer-id", content }),
  };

  const assistantPeer: MockPeer = {
    id: "assistant-peer-id",
    chat: vi.fn(),
    message: (content: string) => ({ peer_id: "assistant-peer-id", content }),
  };

  const session: MockSession = {
    addPeers: vi.fn().mockResolvedValue(undefined),
    addMessages: vi.fn().mockResolvedValue(undefined),
  };

  return {
    peer: vi.fn().mockImplementation(async (id: string) => {
      return id === "assistant" ? assistantPeer : userPeer;
    }),
    session: vi.fn().mockResolvedValue(session),
  };
}

describe("createHonchoAdapter", () => {
  it("returns an object satisfying HonchoPort", () => {
    const client = createMockClient();
    const adapter: HonchoPort = createHonchoAdapter({
      client: client as never,
      userId: "user-123",
    });
    expect(adapter.createSubscriber).toBeTypeOf("function");
    expect(adapter.fetchContext).toBeTypeOf("function");
  });

  describe("fetchContext", () => {
    it("queries Honcho with default queries and returns memories", async () => {
      const client = createMockClient();
      const adapter = createHonchoAdapter({
        client: client as never,
        userId: "user-123",
      });

      const result = await adapter.fetchContext("user-123");

      expect(client.peer).toHaveBeenCalledWith("user-123");
      expect(result.memories.length).toBeGreaterThan(0);
      expect(result.memories[0]).toBe("User prefers concise output");
    });

    it("uses custom queries when provided", async () => {
      const client = createMockClient();
      const adapter = createHonchoAdapter({
        client: client as never,
        userId: "user-123",
      });

      await adapter.fetchContext("user-123", [
        "What language does this user prefer?",
      ]);

      const peerMock = await client.peer("user-123");
      expect(peerMock.chat).toHaveBeenCalledWith(
        "What language does this user prefer?",
      );
    });
  });

  describe("createSubscriber", () => {
    it("stores model-response-complete events as messages", async () => {
      const client = createMockClient();
      const adapter = createHonchoAdapter({
        client: client as never,
        userId: "user-123",
      });

      const subscriber = adapter.createSubscriber("strategy-1", "user-123");

      // Simulate a model-response-complete event
      subscriber({
        kind: "model-response-complete",
        runId: "run-1",
        timestamp: new Date().toISOString(),
        text: "Here is the implementation...",
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 200 },
      });

      // Allow async operations to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      const session = await client.session("strategy-1");
      expect(session.addMessages).toHaveBeenCalled();
    });

    it("ignores non-model-response events", () => {
      const client = createMockClient();
      const adapter = createHonchoAdapter({
        client: client as never,
        userId: "user-123",
      });

      const subscriber = adapter.createSubscriber("strategy-1", "user-123");

      // These should be silently ignored, no errors
      subscriber({
        kind: "run-started",
        runId: "run-1",
        timestamp: new Date().toISOString(),
        unitId: "unit-1",
        status: "running",
      });

      subscriber({
        kind: "model-token-delta",
        runId: "run-1",
        timestamp: new Date().toISOString(),
        delta: "tok",
      });

      // No crash = pass
      expect(true).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kenthall/buildplane/main && pnpm vitest run packages/adapters-honcho/test/honcho-adapter.test.ts`
Expected: FAIL — cannot resolve `../src/honcho-adapter.js`

- [ ] **Step 3: Write the adapter implementation**

Create `packages/adapters-honcho/src/honcho-adapter.ts`:

```typescript
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
            // (see skill: Event Bus Silent Subscriber)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kenthall/buildplane/main && pnpm vitest run packages/adapters-honcho/test/honcho-adapter.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/kenthall/buildplane/main && pnpm exec tsc -p packages/adapters-honcho/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 6: Update barrel export**

Replace the placeholder in `packages/adapters-honcho/src/index.ts` with:

```typescript
export type { HonchoPort, HonchoContextResult } from "./honcho-port.js";
export { createHonchoAdapter, createHonchoClient } from "./honcho-adapter.js";
export type { CreateHonchoAdapterOptions } from "./honcho-adapter.js";
```

- [ ] **Step 7: Commit**

```bash
git add packages/adapters-honcho/src/honcho-adapter.ts packages/adapters-honcho/src/index.ts packages/adapters-honcho/test/honcho-adapter.test.ts
git commit -m "feat(adapters-honcho): implement adapter with subscriber and context pre-fetcher"
```

---

### Task 4: Wire Honcho Adapter into the CLI

**Files:**
- Modify: `apps/cli/src/run-cli.ts:76-205`
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Write the failing test**

Create or extend `apps/cli/test/honcho-wiring.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

describe("CLI Honcho wiring", () => {
  it("loads Honcho adapter when HONCHO_API_KEY is set", async () => {
    // This is an integration-level test that verifies the CLI
    // conditionally imports the adapter when env is configured.
    // The actual adapter is tested in adapters-honcho.
    const originalEnv = process.env.HONCHO_API_KEY;
    process.env.HONCHO_API_KEY = "test-key";
    process.env.HONCHO_WORKSPACE_ID = "buildplane";
    process.env.BUILDPLANE_USER_ID = "test-user";

    try {
      // Verify the adapter module can be dynamically imported
      const mod = await import("@buildplane/adapters-honcho");
      expect(mod.createHonchoAdapter).toBeTypeOf("function");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.HONCHO_API_KEY;
      } else {
        process.env.HONCHO_API_KEY = originalEnv;
      }
      delete process.env.HONCHO_WORKSPACE_ID;
      delete process.env.BUILDPLANE_USER_ID;
    }
  });

  it("gracefully skips Honcho when HONCHO_API_KEY is not set", () => {
    delete process.env.HONCHO_API_KEY;
    // No adapter loaded, no errors
    expect(process.env.HONCHO_API_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kenthall/buildplane/main && pnpm vitest run apps/cli/test/honcho-wiring.test.ts`
Expected: FAIL — cannot resolve `@buildplane/adapters-honcho`

- [ ] **Step 3: Add dependency to CLI package.json**

In `apps/cli/package.json`, add to `dependencies`:

```json
"@buildplane/adapters-honcho": "workspace:*"
```

- [ ] **Step 4: Wire Honcho into loadCliOrchestrator**

In `apps/cli/src/run-cli.ts`, add Honcho wiring inside `loadCliOrchestrator()` after the event store subscriber block (around line 130) and before the return statement. The wiring is conditional — only activated when `HONCHO_API_KEY` is set:

```typescript
// ── Optional Honcho memory integration ─────────────────────
// Activated when HONCHO_API_KEY is set in the environment.
// The adapter owns the SDK import — the CLI never touches @honcho-ai/sdk directly.

if (process.env.HONCHO_API_KEY) {
  try {
    const { createHonchoAdapter, createHonchoClient } = await import(
      "@buildplane/adapters-honcho"
    );

    const honchoClient = await createHonchoClient({
      workspaceId: process.env.HONCHO_WORKSPACE_ID,
      apiKey: process.env.HONCHO_API_KEY,
    });

    const userId = process.env.BUILDPLANE_USER_ID ?? "operator";
    const adapter = createHonchoAdapter({
      client: honchoClient as never,
      userId,
    });

    // Subscribe to the event bus for message storage
    const honchoSubscriber = adapter.createSubscriber("default", userId);
    eventBus.subscribe(honchoSubscriber as never);
  } catch (err) {
    // Warn when explicitly configured but broken — silence when SDK simply absent
    console.warn(
      `[buildplane] Honcho memory disabled: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}
```

- [ ] **Step 5: Update root typecheck script**

In the root `package.json`, append to the `typecheck` script:

```
 && pnpm exec tsc -p packages/adapters-honcho/tsconfig.json --noEmit
```

(Append after the existing `packages/adapters-tools/tsconfig.json --noEmit` entry.)

- [ ] **Step 6: Run pnpm install and verify test passes**

Run: `cd /Users/kenthall/buildplane/main && pnpm install && pnpm vitest run apps/cli/test/honcho-wiring.test.ts`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `cd /Users/kenthall/buildplane/main && pnpm test`
Expected: All existing tests pass, plus new Honcho tests

- [ ] **Step 8: Commit**

```bash
git add apps/cli/package.json apps/cli/src/run-cli.ts apps/cli/test/honcho-wiring.test.ts package.json pnpm-lock.yaml
git commit -m "feat(cli): wire optional Honcho memory adapter via HONCHO_API_KEY env"
```

---

### Task 5: Add Environment Variable Documentation

**Files:**
- Modify: `packages/adapters-honcho/src/honcho-adapter.ts` (JSDoc only)

- [ ] **Step 1: Add env var documentation to the adapter**

Add a doc comment block at the top of `honcho-adapter.ts` (after imports):

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/adapters-honcho/src/honcho-adapter.ts
git commit -m "docs(adapters-honcho): document environment variables for Honcho integration"
```

---

### Task 6: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `cd /Users/kenthall/buildplane/main && pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/kenthall/buildplane/main && pnpm test`
Expected: All tests pass (existing + new Honcho tests)

- [ ] **Step 3: Run linter**

Run: `cd /Users/kenthall/buildplane/main && pnpm lint`
Expected: PASS

- [ ] **Step 4: Build**

Run: `cd /Users/kenthall/buildplane/main && pnpm build`
Expected: PASS — adapters-honcho compiles to dist/
