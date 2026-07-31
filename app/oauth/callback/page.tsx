import { redirect } from "next/navigation";
import { OAuthCallbackSession } from "@/components/OAuthCallbackSession";
import {
  assertStrictLocalEnvironment,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";

export const dynamic = "force-dynamic";

export default function OAuthCallbackPage() {
  if (!strictLocalModeEnabled()) redirect("/login");
  assertStrictLocalEnvironment();
  return <OAuthCallbackSession />;
}
