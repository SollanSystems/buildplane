import type { EventBus } from "@buildplane/kernel";
import { Box, Text, useApp } from "ink";
import { useEffect } from "react";
import { type RunViewState, useRunState } from "./hooks/use-run-state.js";

interface TuiAppProps {
	eventBus: EventBus;
}

function PhaseIndicator({ phase }: { phase: RunViewState["phase"] }) {
	const labels: Record<RunViewState["phase"], { text: string; color: string }> =
		{
			idle: { text: "⏳ Idle", color: "gray" },
			pending: { text: "⏳ Pending", color: "yellow" },
			running: { text: "▶ Running", color: "blue" },
			executing: { text: "⚙ Executing", color: "cyan" },
			evidence: { text: "📋 Evidence", color: "blue" },
			policy: { text: "⚖ Policy", color: "magenta" },
			completed: { text: "✓ Passed", color: "green" },
			failed: { text: "✗ Failed", color: "red" },
			error: { text: "⚠ Error", color: "red" },
		};

	const label = labels[phase];
	return <Text color={label.color}>{label.text}</Text>;
}

function ModelOutputPane({ text }: { text: string }) {
	return (
		<Box
			flexDirection="column"
			flexGrow={1}
			borderStyle="single"
			borderColor="gray"
			paddingX={1}
		>
			<Text bold color="cyan">
				Model Output
			</Text>
			<Text>{text || "Waiting for model response..."}</Text>
		</Box>
	);
}

function ToolCallsPane({
	toolCalls,
}: {
	toolCalls: RunViewState["toolCalls"];
}) {
	if (toolCalls.length === 0) return null;

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor="gray"
			paddingX={1}
		>
			<Text bold color="yellow">
				Tool Calls
			</Text>
			{toolCalls.map((tc) => (
				<Box key={tc.id}>
					<Text color={tc.status === "completed" ? "green" : "cyan"}>
						{tc.status === "completed" ? "  ✓" : "  ⟳"} {tc.name}
					</Text>
				</Box>
			))}
		</Box>
	);
}

function StatusBar({ state }: { state: RunViewState }) {
	return (
		<Box
			borderStyle="single"
			borderColor="gray"
			paddingX={1}
			justifyContent="space-between"
		>
			<PhaseIndicator phase={state.phase} />
			<Text>
				Evidence: <Text bold>{state.evidenceCount}</Text>
			</Text>
			{state.policyOutcome && (
				<Text>
					Policy:{" "}
					<Text
						bold
						color={state.policyOutcome === "approved" ? "green" : "red"}
					>
						{state.policyOutcome}
					</Text>
				</Text>
			)}
			{state.error && <Text color="red">Error: {state.error}</Text>}
		</Box>
	);
}

export function TuiApp({ eventBus }: TuiAppProps) {
	const state = useRunState(eventBus);
	const { exit } = useApp();

	useEffect(() => {
		if (state.done) {
			// Small delay to let the final render flush
			const timer = setTimeout(() => {
				exit();
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [state.done, exit]);

	return (
		<Box flexDirection="column" width="100%">
			<Box paddingX={1} marginBottom={0}>
				<Text bold>
					Buildplane {state.unitId && <Text dimColor>— {state.unitId}</Text>}
				</Text>
			</Box>
			<ModelOutputPane text={state.modelText} />
			<ToolCallsPane toolCalls={state.toolCalls} />
			<StatusBar state={state} />
		</Box>
	);
}
