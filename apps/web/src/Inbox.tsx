// @jsxRuntime automatic
// @jsxImportSource react
import { useCallback, useEffect, useState } from "react";
import { fetchInbox } from "./api";
import { DecisionDialog } from "./DecisionDialog";
import type { OperatorDecisionVerdict, PendingOperatorDecision } from "./types";

interface ActiveDecision {
	item: PendingOperatorDecision;
	decision: OperatorDecisionVerdict;
}

export function Inbox() {
	const [items, setItems] = useState<PendingOperatorDecision[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [active, setActive] = useState<ActiveDecision | null>(null);

	useEffect(() => {
		let mounted = true;
		fetchInbox()
			.then((pending) => {
				if (mounted) {
					setItems(pending);
					setLoadError(null);
				}
			})
			.catch((error: unknown) => {
				if (mounted) {
					setLoadError(
						error instanceof Error ? error.message : "failed to load inbox",
					);
				}
			});
		return () => {
			mounted = false;
		};
	}, []);

	const onResolved = useCallback((runId: string) => {
		setItems((prev) => prev.filter((item) => item.runId !== runId));
	}, []);

	const resumeCount = items.filter((item) => item.subject === "resume").length;
	const mergeCount = items.filter((item) => item.subject === "merge").length;

	return (
		<section data-testid="inbox-view" className="inbox">
			<header className="inbox-header">
				<h1>Approval inbox</h1>
				<span data-testid="inbox-badge" className="inbox-badge">
					<span data-testid="badge-total" className="badge badge--total">
						{items.length} pending
					</span>
					<span data-testid="badge-resume" className="badge badge--resume">
						{resumeCount} resume
					</span>
					<span data-testid="badge-merge" className="badge badge--merge">
						{mergeCount} merge
					</span>
				</span>
			</header>

			{loadError ? (
				<p role="alert" data-testid="inbox-error" className="inbox-error">
					{loadError}
				</p>
			) : null}

			{items.length === 0 && !loadError ? (
				<p data-testid="inbox-empty" className="inbox-empty">
					No pending decisions.
				</p>
			) : null}

			<ul className="inbox-list">
				{items.map((item) => (
					<li
						key={item.runId}
						data-testid={`inbox-item-${item.runId}`}
						className={`inbox-item inbox-item--${item.subject}`}
					>
						<span className="inbox-item-run">{item.runId}</span>
						<span
							data-testid={`item-subject-${item.runId}`}
							className={`inbox-subject inbox-subject--${item.subject}`}
						>
							{item.subject === "merge"
								? "merge / quarantine"
								: "resume / reject"}
						</span>
						<time className="inbox-since" dateTime={item.since}>
							{item.since}
						</time>
						<a
							data-testid={`inspector-link-${item.runId}`}
							className="inbox-inspector-link"
							href={`#/runs?run=${item.runId}`}
						>
							Inspect
						</a>
						<button
							type="button"
							data-testid={`approve-${item.runId}`}
							onClick={() => setActive({ item, decision: "approved" })}
						>
							Approve
						</button>
						<button
							type="button"
							data-testid={`reject-${item.runId}`}
							onClick={() => setActive({ item, decision: "rejected" })}
						>
							Reject
						</button>
					</li>
				))}
			</ul>

			{active ? (
				<DecisionDialog
					runId={active.item.runId}
					subject={active.item.subject}
					decision={active.decision}
					onResolved={onResolved}
					onClose={() => setActive(null)}
				/>
			) : null}
		</section>
	);
}
