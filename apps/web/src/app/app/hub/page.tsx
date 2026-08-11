import type { Metadata } from "next";
import HubView from "@/app/hub/HubView";
import { TOOL_COUNT } from "@/lib/agent-tools";

export const metadata: Metadata = {
  title: `Blue Hub — ${TOOL_COUNT} AI Tools on Base`,
  description: `${TOOL_COUNT} x402 AI tools for Base. Pay per call. No API key. No subscription.`,
};

export default function AppHubPage() {
  return <HubView inShell />;
}
