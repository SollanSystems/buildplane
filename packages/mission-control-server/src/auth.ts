import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The source of the bearer token that gates every WRITE request. Injected so
 * tests supply a fixed token and production reads `~/.buildplane/web-token`.
 */
export interface BearerTokenSource {
	read(): string | undefined;
}

export function defaultWebTokenPath(): string {
	return join(homedir(), ".buildplane", "web-token");
}

export function fileBearerTokenSource(tokenPath: string): BearerTokenSource {
	return {
		read() {
			try {
				const token = readFileSync(tokenPath, "utf8").trim();
				return token.length > 0 ? token : undefined;
			} catch {
				return undefined;
			}
		},
	};
}

function parseBearer(header: string | undefined): string | undefined {
	if (!header) {
		return undefined;
	}
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match ? match[1].trim() : undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	if (a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

/**
 * Authorize a write request. Fails closed: no configured token, no/garbled
 * `Authorization` header, or a mismatch all return false. Reads are never gated.
 */
export function isAuthorizedWrite(
	authorizationHeader: string | undefined,
	tokenSource: BearerTokenSource,
): boolean {
	const expected = tokenSource.read();
	if (!expected) {
		return false;
	}
	const provided = parseBearer(authorizationHeader);
	if (!provided) {
		return false;
	}
	return constantTimeEquals(provided, expected);
}
