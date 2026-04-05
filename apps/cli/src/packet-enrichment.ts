interface MemoryPortLike {
	fetchLearnings(options?: { limit?: number }): ReadonlyArray<{
		kind: string;
		title: string;
		body: string;
	}>;
}

interface HonchoPortLike {
	fetchContext(userId: string): Promise<{ memories: string[] }>;
}

export async function enrichPacketWithMemories(
	packet: unknown,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
): Promise<unknown> {
	const p = packet as { intent?: { context?: Record<string, unknown> } };
	if (!p.intent) return packet;
	if (!memoryPort && !honchoAdapter) return packet;

	const localLearnings = memoryPort?.fetchLearnings({ limit: 10 }) ?? [];
	const honchoMemories =
		honchoAdapter && userId
			? (await honchoAdapter.fetchContext(userId)).memories.map(
					(m) => `[honcho] ${m}`,
				)
			: [];

	const memories = [
		...localLearnings.map((l) => `[${l.kind}] ${l.title}: ${l.body}`),
		...honchoMemories,
	];

	if (memories.length === 0) return packet;

	return {
		...(packet as object),
		intent: {
			...(p.intent as object),
			context: {
				...(p.intent.context as object),
				memories,
			},
		},
	};
}

export async function enrichGraphWithMemories(
	graph: Record<string, unknown>,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
): Promise<unknown> {
	const nodes = (graph.nodes as unknown[]) ?? [];
	const enriched = await Promise.all(
		nodes.map((node) =>
			enrichPacketWithMemories(node, memoryPort, honchoAdapter, userId),
		),
	);
	return { ...graph, nodes: enriched };
}

export async function enrichStrategyWithMemories(
	strategy: Record<string, unknown>,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
): Promise<unknown> {
	const children = (strategy.children as Array<{ packet: unknown }>) ?? [];
	const enrichedChildren = await Promise.all(
		children.map(async (child) => ({
			...child,
			packet: await enrichPacketWithMemories(
				child.packet,
				memoryPort,
				honchoAdapter,
				userId,
			),
		})),
	);
	return { ...strategy, children: enrichedChildren };
}
