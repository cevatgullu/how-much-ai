export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ assertStrictLocalEnvironment }, { installStrictLocalFetchPolicy }] = await Promise.all([
    import("./lib/strict-local-mode"),
    import("./lib/outbound-fetch-policy"),
  ]);
  assertStrictLocalEnvironment();
  installStrictLocalFetchPolicy();
}
