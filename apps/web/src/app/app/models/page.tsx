"use client";

// /app/models — the model catalog promoted to a first-class Control page.
//
// Reuses the very same <ModelsPanel> that renders as a tab inside Blue Chat, so
// the list is identical (no fork, no mock). What differs is what "picking"
// means here: `chatTier` is in-memory state (ChatContext's useState, never
// persisted) owned by the chat surface's own ChatProvider, and this page mounts
// a *separate* provider via PanelHost. Setting the tier locally would therefore
// be silently discarded the moment the user navigates to /chat.
//
// So a pick routes through /chat?preset=<id>, which ChatContext already reads
// and validates against the live preset ids — the same shape as /app/skills
// routing its pick to /chat?prefill=<trigger> because a standalone page has no
// local chat session to configure.

import { useRouter } from "next/navigation";
import PanelHost from "../_PanelHost";
import ModelsPanel from "@/app/chat/components/ModelsPanel";

export default function ModelsPage() {
  const router = useRouter();
  return (
    <PanelHost
      title="Models"
      subtitle="Every model Blue Chat can run · publisher · context window · credits per message"
    >
      <ModelsPanel onPick={(id) => router.push("/chat?preset=" + encodeURIComponent(id))} />
    </PanelHost>
  );
}
