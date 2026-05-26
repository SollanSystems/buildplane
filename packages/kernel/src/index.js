import {
	createRunAdmissionReceiptDryRun as createRunAdmissionReceiptDryRunImpl,
	createRunAdmissionRecordedPayload as createRunAdmissionRecordedPayloadImpl,
	RunAdmissionReceiptInputError as RunAdmissionReceiptInputErrorImpl,
	recordRunAdmissionReceiptAttempt as recordRunAdmissionReceiptAttemptImpl,
} from "./admission-receipts.ts";
import { createEventBus as createEventBusImpl } from "./events.ts";
import {
	compareRankedMemoryResults as compareRankedMemoryResultsImpl,
	createRankedMemoryResult as createRankedMemoryResultImpl,
	dedupeRankedMemoryResults as dedupeRankedMemoryResultsImpl,
	getStructuredMemoryMatchClass as getStructuredMemoryMatchClassImpl,
	rankMemoryResults as rankMemoryResultsImpl,
} from "./memory-retrieval.ts";
import { createBuildplaneOrchestrator as createBuildplaneOrchestratorImpl } from "./orchestrator.ts";
import { parseUnitPacket as parseUnitPacketImpl } from "./packet.ts";
import { createRunScopedBus as createRunScopedBusImpl } from "./run-scoped-bus.ts";
import { validatePacketForWorkspaceRoot as validatePacketForWorkspaceRootImpl } from "./workspace-paths.ts";

/** @type {typeof import('./orchestrator.ts').createBuildplaneOrchestrator} */
export const createBuildplaneOrchestrator = createBuildplaneOrchestratorImpl;
/** @type {typeof import('./admission-receipts.ts').createRunAdmissionReceiptDryRun} */
export const createRunAdmissionReceiptDryRun =
	createRunAdmissionReceiptDryRunImpl;
/** @type {typeof import('./admission-receipts.ts').createRunAdmissionRecordedPayload} */
export const createRunAdmissionRecordedPayload =
	createRunAdmissionRecordedPayloadImpl;
/** @type {typeof import('./admission-receipts.ts').RunAdmissionReceiptInputError} */
export const RunAdmissionReceiptInputError = RunAdmissionReceiptInputErrorImpl;
/** @type {typeof import('./admission-receipts.ts').recordRunAdmissionReceiptAttempt} */
export const recordRunAdmissionReceiptAttempt =
	recordRunAdmissionReceiptAttemptImpl;
/** @type {typeof import('./events.ts').createEventBus} */
export const createEventBus = createEventBusImpl;
/** @type {typeof import('./memory-retrieval.ts').compareRankedMemoryResults} */
export const compareRankedMemoryResults = compareRankedMemoryResultsImpl;
/** @type {typeof import('./memory-retrieval.ts').createRankedMemoryResult} */
export const createRankedMemoryResult = createRankedMemoryResultImpl;
/** @type {typeof import('./memory-retrieval.ts').dedupeRankedMemoryResults} */
export const dedupeRankedMemoryResults = dedupeRankedMemoryResultsImpl;
/** @type {typeof import('./memory-retrieval.ts').getStructuredMemoryMatchClass} */
export const getStructuredMemoryMatchClass = getStructuredMemoryMatchClassImpl;
/** @type {typeof import('./memory-retrieval.ts').rankMemoryResults} */
export const rankMemoryResults = rankMemoryResultsImpl;
/** @type {typeof import('./run-scoped-bus.ts').createRunScopedBus} */
export const createRunScopedBus = createRunScopedBusImpl;
/** @type {typeof import('./packet.ts').parseUnitPacket} */
export const parseUnitPacket = parseUnitPacketImpl;
/** @type {typeof import('./workspace-paths.ts').validatePacketForWorkspaceRoot} */
export const validatePacketForWorkspaceRoot =
	validatePacketForWorkspaceRootImpl;
