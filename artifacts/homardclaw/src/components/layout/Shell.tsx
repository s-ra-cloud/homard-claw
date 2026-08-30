import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import {
  LogOut,
  Home,
  Users,
  CheckSquare,
  Settings,
  Activity,
  Palmtree,
  Menu,
  X,
  Brain,
  Network,
  Phone,
  CalendarClock,
  Bell,
  BarChart3,
  Maximize2,
  Plug,
  BookOpen,
} from "lucide-react";
import { useListNotifications } from "@workspace/api-client-react";
import { useLiveUpdates } from "@/lib/useLiveUpdates";
import { useIsMobile } from "@/hooks/use-mobile";
import { isOfficeWindowFrame } from "@/lib/office-window";
import "./office-window.css";

const navItems = [
  { href: "/office", label: "Office", icon: Home },
  { href: "/agents", label: "Crustabots", icon: Users },
  { href: "/talk", label: "Talk", icon: Phone },
  { href: "/teams", label: "Teams", icon: Network },
  { href: "/tasks", label: "Tasks", icon: Activity },
  { href: "/schedules", label: "Schedules", icon: CalendarClock },
  { href: "/inbox", label: "Inbox", icon: Bell },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/documentation", label: "Documentation", icon: BookOpen },
  { href: "/approvals", label: "Approvals", icon: CheckSquare },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/providers", label: "Providers", icon: Settings },
  { href: "/connected-apps", label: "Apps", icon: Plug },
  { href: "/island", label: "Island", icon: Palmtree },
];

interface ShellProps {
  children: React.ReactNode;
  /** When true, hides the sidebar and mobile header so the scene fills the viewport. */
  immersive?: boolean;
  /** Called when the user activates the Fullscreen nav action. */
  onEnterImmersive?: () => void;
}
export function Shell(props: ShellProps) {
  if (isOfficeWindowFrame()) {
    return (
      <div className="office-embed-shell">
        <main className="office-embed-shell__content">{props.children}</main>
      </div>
    );
  }

  return <StandardShell {...props} />;
}

function StandardShell({
  children,
  immersive = false,
  onEnterImmersive,
}: ShellProps) {
  const [location] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  // One live-update stream per signed-in view: SSE topic hints invalidate
  // React Query caches so every page refreshes without waiting on polls.
  useLiveUpdates();
  // Unread count for the Inbox badge; SSE keeps it fresh, the interval is
  // only a fallback when the stream is down.
  const { data: notificationData } = useListNotifications(
    { limit: 1 },
    {
      query: {
        queryKey: ["/api/notifications", "badge"],
        refetchInterval: 60_000,
      },
    },
  );
  const unread = notificationData?.unread ?? 0;
  // The office diorama is a wide isometric scene: on a phone it is neither
  // listed nor routable, so the menu drops it entirely.
  const isPhone = useIsMobile();
  const visibleNavItems = isPhone
    ? navItems.filter((item) => item.href !== "/office")
    : navItems;
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // The drawer is route-scoped: navigating away always closes it.
  useEffect(() => {
    setNavOpen(false);
  }, [location]);

  // Immersive mode always closes the mobile drawer.
  useEffect(() => {
    if (immersive) setNavOpen(false);
  }, [immersive]);

  // Growing past the lg breakpoint turns the drawer back into the permanent
  // sidebar, so a stale "open" flag must not survive into desktop.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setNavOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  // While open the drawer behaves as a modal: focus moves in, stays trapped,
  // the rest of the page is inert, and focus returns to the trigger on close.
  useEffect(() => {
    if (!navOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const content = contentRef.current;
    content?.setAttribute("inert", "");

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavOpen(false);
        return;
      }
      if (event.key !== "Tab" || !navRef.current) return;

      const focusables = navRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;

      if (
        event.shiftKey &&
        (active === first || !navRef.current.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      content?.removeAttribute("inert");
      previouslyFocused?.focus?.();
    };
  }, [navOpen]);

  const currentPage = visibleNavItems.find(
    (item) => location === item.href || location.startsWith(item.href + "/"),
  );

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background relative">
      {/* Scanline overlay for that CRT monitor feel */}
      <div className="absolute inset-0 scanlines z-50 pointer-events-none opacity-50 mix-blend-overlay"></div>

      {/* Sidebar — a full-screen menu below lg, permanent from lg up;
          hidden entirely in immersive mode */}
      <aside
        id="main-nav"
        ref={navRef}
        aria-label="Main navigation"
        aria-hidden={immersive || undefined}
        {...(navOpen ? { role: "dialog" as const, "aria-modal": true } : {})}
        className={`fixed inset-0 z-40 w-full flex flex-col border-border bg-card transition-transform duration-200 ease-out lg:static lg:z-10 lg:w-64 lg:shrink-0 lg:translate-x-0 lg:border-r-4 lg:pixel-shadow ${
          immersive ? "hidden" : navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-4 sm:p-6 border-b-4 border-border bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary pixel-shadow flex items-center justify-center shrink-0">
              <span className="font-display text-white text-xs">CB</span>
            </div>
            <h1 className="font-display text-sm text-primary uppercase tracking-tighter">
              Crustabox
            </h1>
            <button
              type="button"
              ref={closeButtonRef}
              onClick={() => setNavOpen(false)}
              className="ml-auto flex items-center justify-center w-10 h-10 border-2 border-border bg-background/40 text-foreground pixel-shadow lg:hidden"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground uppercase">
            Control Room v1.0
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 py-6 grid grid-cols-2 gap-3 content-start sm:grid-cols-3 lg:flex lg:flex-col lg:gap-2">
          {visibleNavItems.map((item) => {
            const isActive =
              location === item.href || location.startsWith(item.href + "/");
            return (
              <Link key={item.href} href={item.href} className="block h-full">
                <div
                  className={`flex h-full items-center gap-3 px-4 py-4 cursor-pointer transition-colors lg:py-3 ${
                    isActive
                      ? "bg-primary text-primary-foreground pixel-shadow"
                      : "text-foreground hover:bg-muted pixel-shadow"
                  }`}
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span className="font-bold text-sm tracking-wide uppercase truncate">
                    {item.label}
                  </span>
                  {item.href === "/inbox" && unread > 0 && (
                    <span
                      className={`ml-auto min-w-[1.25rem] px-1 py-0.5 text-center text-[10px] font-bold leading-none ${
                        isActive
                          ? "bg-primary-foreground text-primary"
                          : "bg-destructive text-destructive-foreground"
                      }`}
                      data-testid="badge-unread-count"
                    >
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}

          {onEnterImmersive && (
            <button
              type="button"
              onClick={() => {
                setNavOpen(false);
                onEnterImmersive();
              }}
              className="w-full h-full flex items-center gap-3 px-4 py-4 text-foreground hover:bg-muted pixel-shadow transition-colors lg:py-3"
              aria-label="Enter fullscreen office view"
              title="Opens the immersive office scene — press Escape to exit"
            >
              <Maximize2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="font-bold text-sm tracking-wide uppercase">
                Fullscreen
              </span>
            </button>
          )}
        </nav>

        <div className="p-4 border-t-4 border-border bg-muted/30">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-secondary pixel-shadow border-2 border-border overflow-hidden flex items-center justify-center shrink-0">
              {user?.imageUrl ? (
                <img
                  src={user.imageUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <span className="font-display text-[10px] text-secondary-foreground uppercase">
                  {(user?.firstName ?? "D").slice(0, 1)}
                </span>
              )}
            </div>
            <div className="overflow-hidden">
              <div className="text-xs font-bold truncate text-accent">
                {user?.firstName || "Director"}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">
                {user?.primaryEmailAddress?.emailAddress}
              </div>
            </div>
          </div>
          <button
            onClick={() => signOut()}
            className="w-full flex items-center justify-center gap-2 py-2 bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors pixel-shadow border-2 border-destructive uppercase text-xs font-bold"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0" ref={contentRef}>
        {/* Mobile top bar — hidden in immersive mode */}
        {!immersive && (
          <header className="lg:hidden flex items-center gap-3 h-14 shrink-0 px-3 border-b-4 border-border bg-card z-20">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              className="flex items-center justify-center w-10 h-10 border-2 border-border bg-muted/40 text-foreground pixel-shadow"
              aria-label="Open menu"
              aria-expanded={navOpen}
              aria-controls="main-nav"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="w-8 h-8 bg-primary pixel-shadow flex items-center justify-center shrink-0">
              <span className="font-display text-white text-xs">CB</span>
            </div>
            <span className="font-display text-xs text-primary uppercase tracking-tighter truncate">
              {currentPage?.label ?? "Crustabox"}
            </span>
          </header>
        )}

        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-background relative z-0">
          {children}
        </main>
      </div>

      {/* Non-interactive ESC hint shown only during immersive mode */}
      {immersive && (
        <div
          className="fixed bottom-4 right-4 z-[60] pointer-events-none select-none"
          role="status"
          aria-live="polite"
          aria-label="Press Escape to exit immersive view"
        >
          <span
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: "10px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              color: "rgba(255, 240, 205, 0.75)",
              background: "rgba(43, 39, 51, 0.65)",
              border: "2px solid rgba(255, 240, 205, 0.3)",
              padding: "4px 10px",
              display: "block",
              boxShadow: "2px 2px 0 rgba(0,0,0,0.4)",
            }}
          >
            ESC — exit
          </span>
        </div>
      )}
    </div>
  );
}
