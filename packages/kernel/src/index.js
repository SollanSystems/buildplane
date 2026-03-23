import { createEventBus as createEventBusImpl } from "./events.ts";
import { createBuildplaneOrchestrator as createBuildplaneOrchestratorImpl } from "./orchestrator.ts";
import { parseUnitPacket as parseUnitPacketImpl } from "./packet.ts";
import { validatePacketForWorkspaceRoot as validatePacketForWorkspaceRootImpl } from "./workspace-paths.ts";

/** @type {typeof import('./orchestrator.ts').createBuildplaneOrchestrator} */
export const createBuildplaneOrchestrator = createBuildplaneOrchestratorImpl;
/** @type {typeof import('./events.ts').createEventBus} */
export const createEventBus = createEventBusImpl;
/** @type {typeof import('./packet.ts').parseUnitPacket} */
export const parseUnitPacket = parseUnitPacketImpl;
/** @type {typeof import('./workspace-paths.ts').validatePacketForWorkspaceRoot} */
export const validatePacketForWorkspaceRoot =
	validatePacketForWorkspaceRootImpl;
