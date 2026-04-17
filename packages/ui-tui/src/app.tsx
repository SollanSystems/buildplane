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
			suspended: { text: "⏸ Suspended", color: "yellow" },
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

function OperatorSummaryPane({ state }: { state: RunViewState }) {
	const lines: Array<{ label: string; value: string; color?: string }> = [];

	if (state.graphId) {
		lines.push({
			label: "Graph",
			value: `${state.graphId}${state.graphUnitCount ? ` units=${state.graphUnitCount}` : ""}${state.graphOutcome ? ` outcome=${state.graphOutcome}` : state.graphActive ? " active" : ""}`,
			color:
				state.graphOutcome === "failed"
					? "red"
					: state.graphOutcome === "passed"
						? "green"
						: "cyan",
		});
	}

	if (state.suspensionReason) {
		lines.push({
			label: "Suspended",
			value: `${state.suspensionProfile ?? "operator-gate"}: ${state.suspensionReason}`,
			color: "yellow",
		});
	}

	if (state.budgetAlert) {
		lines.push({
			label: "Budget",
			value: `${state.budgetAlert.budgetType} actual=${state.budgetAlert.actual} limit=${state.budgetAlert.limit}`,
			color: "red",
		});
	}

	if (state.policyReasons.length > 0) {
		lines.push({
			label: "Policy",
			value: state.policyReasons.join("; "),
			color: state.policyOutcome === "approved" ? "green" : "yellow",
		});
	}

	const contextBits = [
		state.strategyId ? `strategy=${state.strategyId}` : null,
		state.parentRunId ? `parent=${state.parentRunId}` : null,
		state.role ? `role=${state.role}` : null,
		state.provider ? `provider=${state.provider}` : null,
		state.model ? `model=${state.model}` : null,
		state.estimatedUsd !== null
			? `cost=$${state.estimatedUsd.toFixed(2)}`
			: null,
	].filter(Boolean);

	if (contextBits.length > 0) {
		lines.push({
			label: "Context",
			value: contextBits.join(" "),
			color: "magenta",
		});
	}

	if (lines.length === 0) {
		return null;
	}

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor="gray"
			paddingX={1}
		>
			<Text bold color="magenta">
				Operator Summary
			</Text>
			{lines.map((line) => (
				<Text key={line.label} color={line.color}>
					{line.label}: {line.value}
				</Text>
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
			<OperatorSummaryPane state={state} />
			<ToolCallsPane toolCalls={state.toolCalls} />
			<StatusBar state={state} />
		</Box>
	);
}
