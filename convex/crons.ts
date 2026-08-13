import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Poll usage every minute. The cron only pokes the Next app (see notify.pingCheck) — the app
// decrypts the vault, fetches provider usage, runs the detector, and dispatches events.
//
// Budget, measured against the Convex free tier (1M function calls/month) at ~12 calls per
// normal cycle: 60s ≈ 43.8k cycles ≈ 526k calls, about half the allowance. Going faster does
// not fit — 30s already exceeds it — and would also multiply requests to undocumented provider
// endpoints, which is the constraint that actually bites: at one minute with eight accounts
// that is already ~350k provider requests a month from a single address.
const crons = cronJobs();

crons.interval("check usage", { minutes: 1 }, internal.notify.pingCheck, {});

export default crons;
