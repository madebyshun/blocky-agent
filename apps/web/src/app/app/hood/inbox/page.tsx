/**
 * /hood/inbox — Blue Hood alert inbox (T-D D1).
 *
 * Source of truth for every arrow the engine has fired. Unlike /hood
 * (live board) and /hood/arrows (public track record), this is the
 * per-user inbox: unread badging + "mark all read" bookmark writes.
 */
import type { Metadata } from "next";
import InboxClient from "./InboxClient";

export const metadata: Metadata = {
  title: "Blue Hood · Inbox",
  description: "Every arrow Blue Hood has fired for you. Read/unread.",
  // PWA hook — Blue Hood has its own manifest so a user can Add-to-Home-Screen
  // and receive push notifications on iOS without any of the wider app coming
  // along. See public/hood-manifest.json.
  manifest: "/hood-manifest.json",
};

export const revalidate = 0;
export const dynamic = "force-dynamic";

export default function InboxPage() {
  return <InboxClient />;
}
