/**
 * Return the Buildplane bootstrap banner.
 */
export function getBootstrapBanner(): string {
  return "Buildplane by SollanSystems";
}

// CLI entrypoint — print the banner when run directly.
// Node ESM: import.meta.url matches the argv entry.
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  console.log(getBootstrapBanner());
}
