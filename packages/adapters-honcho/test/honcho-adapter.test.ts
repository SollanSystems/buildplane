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
