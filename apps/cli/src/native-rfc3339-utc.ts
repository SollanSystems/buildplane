const CHRONO_RFC3339_UTC =
	/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const MILLIS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;
const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_MILLISECOND = 1_000_000n;
// Chrono derives `Ord` for `NaiveTime`, so it orders `(seconds_of_day, frac)`
// structurally. A leap second keeps the preceding second field with a frac in
// [1e9, 2e9), therefore each sortable clock second needs two nanoseconds
// ranges to preserve that ordering without collapsing it onto the next second.
const ORDERING_NANOS_PER_SECOND = 2n * NANOS_PER_SECOND;
const ORDERING_NANOS_PER_DAY =
	BigInt(SECONDS_PER_DAY) * ORDERING_NANOS_PER_SECOND;

export interface NativeRfc3339UtcTimestamp {
	readonly text: string;
	readonly orderingNanos: bigint;
}

interface ParsedNativeRfc3339UtcTimestamp {
	readonly timestamp: NativeRfc3339UtcTimestamp;
	readonly daysSinceUnixEpoch: bigint;
	readonly secondsOfDay: number;
	/** Chrono stores a leap second as the preceding second with >= 1e9 nanos. */
	readonly chronoFractionNanos: bigint;
}

/**
 * Match the native `ends_with('Z') + DateTime::parse_from_rfc3339` grammar
 * used by replay. Chrono permits `T`, `t`, or a space separator, leap second
 * `:60`, and arbitrary fractional precision while retaining only the first
 * nine digits. The ordering key mirrors Chrono's date/time ordering rather
 * than collapsing a leap second onto the next Unix second.
 */
export function parseNativeRfc3339Utc(
	value: unknown,
): NativeRfc3339UtcTimestamp | undefined {
	return parseNativeRfc3339UtcDetails(value)?.timestamp;
}

/**
 * Mirror Chrono's `DateTime::checked_add_signed(Duration::milliseconds(..))`
 * for the non-negative compute budgets admitted by a signed dispatch. This
 * retains Chrono's special leap-second arithmetic rather than treating every
 * day as a fixed Unix-duration day.
 */
export function addNativeRfc3339UtcMilliseconds(
	value: unknown,
	milliseconds: number,
): bigint | undefined {
	const parsed = parseNativeRfc3339UtcDetails(value);
	if (
		parsed === undefined ||
		!Number.isSafeInteger(milliseconds) ||
		milliseconds < 0
	) {
		return undefined;
	}

	const secondsToAdd = Math.floor(milliseconds / 1_000);
	const fractionalNanosToAdd =
		BigInt(milliseconds % 1_000) * NANOS_PER_MILLISECOND;
	let seconds = parsed.secondsOfDay;
	let fractionalNanos = parsed.chronoFractionNanos;

	// This is Chrono's `NaiveTime::overflowing_add_signed` leap branch for
	// positive durations. A duration remains inside a leap second only while
	// its fractional addition does not cross its two-billion-nanosecond end.
	if (fractionalNanos >= NANOS_PER_SECOND) {
		if (
			secondsToAdd > 0 ||
			(fractionalNanosToAdd > 0n &&
				fractionalNanos >= 2n * NANOS_PER_SECOND - fractionalNanosToAdd)
		) {
			fractionalNanos -= NANOS_PER_SECOND;
		} else {
			return orderingNanos(
				parsed.daysSinceUnixEpoch,
				seconds,
				fractionalNanos + fractionalNanosToAdd,
			);
		}
	}

	seconds += secondsToAdd;
	fractionalNanos += fractionalNanosToAdd;
	if (fractionalNanos >= NANOS_PER_SECOND) {
		fractionalNanos -= NANOS_PER_SECOND;
		seconds += 1;
	}
	const daysToAdd = Math.floor(seconds / SECONDS_PER_DAY);
	return orderingNanos(
		parsed.daysSinceUnixEpoch + BigInt(daysToAdd),
		seconds % SECONDS_PER_DAY,
		fractionalNanos,
	);
}

export function isNativeRfc3339Utc(value: unknown): value is string {
	return parseNativeRfc3339Utc(value) !== undefined;
}

function parseNativeRfc3339UtcDetails(
	value: unknown,
): ParsedNativeRfc3339UtcTimestamp | undefined {
	if (typeof value !== "string") return undefined;
	const match = CHRONO_RFC3339_UTC.exec(value);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) {
		return undefined;
	}

	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return undefined;
	}

	const fractionalNanos = BigInt((match[7] ?? "").slice(0, 9).padEnd(9, "0"));
	const daysSinceUnixEpoch = BigInt(date.getTime() / MILLIS_PER_DAY);
	const secondsOfDay = hour * 3_600 + minute * 60 + Math.min(second, 59);
	const chronoFractionNanos =
		fractionalNanos + (second === 60 ? NANOS_PER_SECOND : 0n);
	return Object.freeze({
		timestamp: Object.freeze({
			text: value,
			orderingNanos: orderingNanos(
				daysSinceUnixEpoch,
				secondsOfDay,
				chronoFractionNanos,
			),
		}),
		daysSinceUnixEpoch,
		secondsOfDay,
		chronoFractionNanos,
	});
}

function orderingNanos(
	daysSinceUnixEpoch: bigint,
	secondsOfDay: number,
	fractionalNanos: bigint,
): bigint {
	return (
		daysSinceUnixEpoch * ORDERING_NANOS_PER_DAY +
		BigInt(secondsOfDay) * ORDERING_NANOS_PER_SECOND +
		fractionalNanos
	);
}
