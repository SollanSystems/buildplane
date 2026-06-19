import { evaluateAcceptanceContract as evaluateAcceptanceContractImpl } from "./acceptance.ts";
import { evaluateRun as evaluateRunImpl } from "./decision.ts";

/** @type {typeof import('./acceptance.ts').evaluateAcceptanceContract} */
export const evaluateAcceptanceContract = evaluateAcceptanceContractImpl;

/** @type {typeof import('./decision.ts').evaluateRun} */
export const evaluateRun = evaluateRunImpl;
