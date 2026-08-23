import React from "react";
import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";
import { LogOut, Home, Users, CheckSquare, Settings, AlertTriangle, Activity } from "lucide-react";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();

  const navItems = [
    { href: "/office", label: "Office", icon: Home },
    { href: "/agents", label: "Agents", icon: Users },
    { href: "/tasks", label: "Tasks", icon: Activity },
    { href: "/approvals", label: "Approvals", icon: CheckSquare },
    { href: "/providers", label: "Providers", icon: Settings },
  ];

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background relative">
      {/* Scanline overlay for that CRT monitor feel */}
      <div className="absolute inset-0 scanlines z-50 pointer-events-none opacity-50 mix-blend-overlay"></div>

      {/* Sidebar */}
      <aside className="w-64 flex flex-col border-r-4 border-border bg-card pixel-shadow z-10 shrink-0">
        <div className="p-6 border-b-4 border-border bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary pixel-shadow flex items-center justify-center shrink-0">
              <span className="font-display text-white text-xs">HC</span>
            </div>
            <h1 className="font-display text-sm text-primary uppercase tracking-tighter">HomardClaw</h1>
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground uppercase">Control Room v1.0</div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 py-6 space-y-2">
          {navItems.map((item) => {
            const isActive = location === item.href || location.startsWith(item.href + "/");
            return (
              <Link key={item.href} href={item.href} className="block">
                <div
                  className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground pixel-shadow"
                      : "text-foreground hover:bg-muted pixel-shadow"
                  }`}
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span className="font-bold text-sm tracking-wide uppercase">{item.label}</span>
                </div>
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t-4 border-border bg-muted/30">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-secondary pixel-shadow border-2 border-border overflow-hidden flex items-center justify-center">
              <img src={user?.imageUrl} alt="Avatar" className="w-full h-full object-cover" style={{ imageRendering: "pixelated" }} />
            </div>
            <div className="overflow-hidden">
              <div className="text-xs font-bold truncate text-accent">{user?.firstName || "Director"}</div>
              <div className="text-[10px] text-muted-foreground truncate">{user?.primaryEmailAddress?.emailAddress}</div>
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

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-background relative z-0">
        {children}
      </main>
    </div>
  );
}
