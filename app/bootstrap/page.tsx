import { redirect } from "next/navigation";
import { BootstrapSession } from "@/components/BootstrapSession";
import {
  assertStrictLocalEnvironment,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";

export const dynamic = "force-dynamic";

export default function BootstrapPage() {
  if (!strictLocalModeEnabled()) redirect("/login");
  assertStrictLocalEnvironment();
  return <BootstrapSession />;
}
