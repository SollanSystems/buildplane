import { executePacket as executePacketImpl } from "./command-executor.ts";

/** @type {typeof import('./command-executor.ts').executePacket} */
export const executePacket = executePacketImpl;
export * from "./governed-sandbox.ts";
