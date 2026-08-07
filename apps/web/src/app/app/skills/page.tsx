"use client";

// /app/skills — the Skills catalog promoted to a first-class Control page.
//
// Reuses the very same <SkillsPanel> that renders as a tab inside Blue Chat, so
// the installed-skill list is identical (no fork, no mock). The only difference:
// a standalone page has no local chat composer to seed, so we pass onUse to
// route a pick to /chat?prefill=<trigger> — ChatClient reads that param and
// drops the trigger into the composer on the Chat surface.

import { useRouter } from "next/navigation";
import PanelHost from "../_PanelHost";
import SkillsPanel from "@/app/chat/components/SkillsPanel";

export default function SkillsPage() {
  const router = useRouter();
  return (
    <PanelHost
      title="Skills"
      subtitle="Agent capabilities · Blue Agent · Base MCP · bundled tool packs"
    >
      <SkillsPanel
        onUse={(trigger) =>
          router.push("/chat" + (trigger ? "?prefill=" + encodeURIComponent(trigger) : ""))
        }
      />
    </PanelHost>
  );
}
