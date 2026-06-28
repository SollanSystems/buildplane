// @jsxRuntime automatic
// @jsxImportSource react
import { type ReactNode, useEffect, useState } from "react";
import { fetchRuns } from "./api";
import type { RunListItem, RunStatus } from "./types";

const RUN_STATUSES: readonly RunStatus[] = [
	"pending",
	"running",
	"passed",
	"failed",
	"cancelled",
	"suspended",
];

interface RunListProps {
	onSelect: (runId: string) => void;
	selectedRunId?: string;
	initialStatus?: RunStatus;
}

/**
 * Lists runs for a chosen status (default "running"). Selecting a run surfaces
 * its id to the parent via `onSelect`; the Inspector container does the
 * projection fetch.
 */
export function RunList({
	onSelect,
	selectedRunId,
	initialStatus = "running",
}: RunListProps) {
	const [status, setStatus] = useState<RunStatus>(initialStatus);
	const [runs, setRuns] = useState<readonly RunListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		fetchRuns(status)
			.then((result) => {
				if (!cancelled) {
					setRuns(result.runs);
					setLoading(false);
				}
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setRuns([]);
					setError(
						cause instanceof Error ? cause.message : "failed to load runs",
					);
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [status]);

	let body: ReactNode;
	if (error) {
		body = (
			<p className="run-list-error" data-testid="run-list-error">
				{error}
			</p>
		);
	} else if (loading) {
		body = (
			<p className="run-list-loading" data-testid="run-list-loading">
				loading…
			</p>
		);
	} else if (runs.length === 0) {
		body = (
			<p className="run-list-empty" data-testid="run-list-empty">
				no runs
			</p>
		);
	} else {
		body = (
			<ul className="run-list-items">
				{runs.map((run) => (
					<li key={run.id}>
						<button
							type="button"
							className="run-list-item"
							data-testid="run-list-item"
							data-run-id={run.id}
							aria-current={run.id === selectedRunId}
							onClick={() => onSelect(run.id)}
						>
							<span className="run-id">{run.id}</span>
							<span className="run-unit">{run.unitId}</span>
							<span className="run-status">{run.status}</span>
						</button>
					</li>
				))}
			</ul>
		);
	}

	return (
		<section className="run-list" data-testid="run-list">
			<header className="run-list-header">
				<h2>Runs</h2>
				<label className="run-list-status-label">
					Status
					<select
						className="run-list-status"
						data-testid="run-list-status"
						value={status}
						onChange={(event) => setStatus(event.target.value as RunStatus)}
					>
						{RUN_STATUSES.map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</select>
				</label>
			</header>
			{body}
		</section>
	);
}
