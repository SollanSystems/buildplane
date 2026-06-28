// @jsxRuntime automatic
// @jsxImportSource react
import { useState } from "react";
import {
	DecisionConflictError,
	postDecision,
	setAuthToken,
	UnauthorizedError,
} from "./api";
import type { OperatorDecisionSubject, OperatorDecisionVerdict } from "./types";

interface DecisionDialogProps {
	runId: string;
	subject: OperatorDecisionSubject;
	decision: OperatorDecisionVerdict;
	/** Called after the decision is accepted by the server. */
	onResolved: (runId: string) => void;
	/** Called to dismiss the dialog without resolving. */
	onClose: () => void;
}

type Phase = "idle" | "submitting" | "conflict" | "unauthorized" | "error";

function errorMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : "decision failed";
}

export function DecisionDialog({
	runId,
	subject,
	decision,
	onResolved,
	onClose,
}: DecisionDialogProps) {
	const [phase, setPhase] = useState<Phase>("idle");
	const [message, setMessage] = useState("");
	const [token, setToken] = useState("");

	const submit = async () => {
		setPhase("submitting");
		try {
			await postDecision(runId, { decision, subject });
			onResolved(runId);
			onClose();
		} catch (error) {
			if (error instanceof DecisionConflictError) {
				setMessage(error.message);
				setPhase("conflict");
				return;
			}
			if (error instanceof UnauthorizedError) {
				setPhase("unauthorized");
				return;
			}
			setMessage(errorMessageOf(error));
			setPhase("error");
		}
	};

	const saveTokenAndRetry = () => {
		setAuthToken(token.length > 0 ? token : null);
		void submit();
	};

	const verb = decision === "approved" ? "Approve" : "Reject";
	const subjectLabel = subject === "merge" ? "merge" : "resume";
	const showError = phase === "conflict" || phase === "error";
	const submitting = phase === "submitting";

	return (
		<div
			role="dialog"
			aria-modal="true"
			data-testid="decision-dialog"
			className="decision-dialog"
		>
			<p data-testid="decision-summary">
				{verb} the {subjectLabel} decision for run {runId}?
			</p>

			{showError ? (
				<p role="alert" data-testid="decision-error" className="decision-error">
					{message}
				</p>
			) : null}

			{phase === "unauthorized" ? (
				<div
					data-testid="decision-auth-prompt"
					className="decision-auth-prompt"
				>
					<p>An auth token is required to submit this decision.</p>
					<label className="decision-token-label">
						Bearer token
						<input
							type="password"
							data-testid="decision-token-input"
							value={token}
							onChange={(event) => setToken(event.target.value)}
						/>
					</label>
					<button
						type="button"
						data-testid="decision-token-submit"
						disabled={submitting}
						onClick={saveTokenAndRetry}
					>
						Save token and retry
					</button>
				</div>
			) : null}

			<div className="decision-dialog-actions">
				<button
					type="button"
					data-testid="decision-confirm"
					disabled={submitting}
					onClick={() => void submit()}
				>
					Confirm
				</button>
				<button type="button" data-testid="decision-cancel" onClick={onClose}>
					Cancel
				</button>
			</div>
		</div>
	);
}
