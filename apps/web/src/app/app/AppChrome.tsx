"use client";

/**
 * App chrome context — shared between the /app layout and individual pages.
 *
 * Some pages (notably Blue Chat) need to inject their OWN sub-navigation into
 * the shell: recent conversations, a New chat action, a credits chip. A page
 * registers it via `setContextual(...)` on mount and clears it on unmount, so
 * the shell renders it without knowing anything about chat internals.
 *
 * This drives BOTH the mobile drawer and the desktop sidebar. Blue Chat used to
 * own a second 288px aside of its own next to the shell's 212px one; folding it
 * in here is what let that go (see AppSideNav).
 */
import { createContext, useContext, useState, type ReactNode } from "react";

export interface DrawerNavItem {
  id: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
  onSelect: () => void;
}

export interface DrawerRecent {
  id: string;
  title: string;
  active?: boolean;
  onSelect: () => void;
  /** Short trailing label on desktop, e.g. a relative time ("18m"). Hidden on
   *  hover to make room for the delete control. */
  meta?: string;
  /** Omit to render the row as non-deletable. */
  onDelete?: () => void;
}

export interface ContextualNav {
  /** Title shown in the mobile top bar (e.g. "Blue Chat", "Models"). */
  barTitle: string;
  /** Heading for the contextual group inside the drawer. */
  groupTitle: string;
  /** Primary "New chat" action — surfaced as a compose button in the mobile
   *  top bar and as a prominent button at the top of the drawer. */
  newChat?: () => void;
  items: DrawerNavItem[];
  recents?: DrawerRecent[];
  /** Rendered above the sidebar's own footer. The page supplies a node rather
   *  than data because AppShell mounts OUTSIDE ChatProvider and so cannot call
   *  useChat() to read the credit balance itself. */
  footer?: ReactNode;
}

interface AppChromeValue {
  drawerOpen: boolean;
  setDrawerOpen: (b: boolean) => void;
  contextual: ContextualNav | null;
  setContextual: (n: ContextualNav | null) => void;
}

const Ctx = createContext<AppChromeValue | null>(null);

export function AppChromeProvider({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const [contextual, setContextual]   = useState<ContextualNav | null>(null);
  return (
    <Ctx.Provider value={{ drawerOpen, setDrawerOpen, contextual, setContextual }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAppChrome(): AppChromeValue {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAppChrome must be used inside AppChromeProvider");
  return c;
}
