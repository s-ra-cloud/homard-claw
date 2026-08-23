import React from "react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";

export default function PublicWelcome() {
  const { isSignedIn } = useUser();

  return (
    <div className="min-h-screen bg-background flex flex-col relative overflow-hidden">
      {/* Scanline overlay */}
      <div className="absolute inset-0 scanlines z-50 pointer-events-none opacity-50 mix-blend-overlay"></div>
      
      {/* Grid background pattern */}
      <div 
        className="absolute inset-0 opacity-[0.03] z-0" 
        style={{ 
          backgroundImage: 'linear-gradient(hsl(var(--primary)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary)) 1px, transparent 1px)',
          backgroundSize: '40px 40px' 
        }} 
      ></div>

      <header className="relative z-10 p-6 flex justify-between items-center border-b-4 border-border bg-card/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary pixel-shadow flex items-center justify-center">
            <span className="font-display text-white text-sm">HC</span>
          </div>
          <h1 className="font-display text-xl text-primary uppercase tracking-tighter">HomardClaw</h1>
        </div>
        
        <div>
          {isSignedIn ? (
            <Link href="/office">
              <Button variant="primary">Enter Office</Button>
            </Link>
          ) : (
            <div className="flex gap-4">
              <Link href="/sign-in">
                <Button variant="ghost" className="uppercase font-bold">Sign In</Button>
              </Link>
              <Link href="/sign-up">
                <Button variant="primary">Access Request</Button>
              </Link>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 relative z-10 flex flex-col items-center justify-center p-8 max-w-4xl mx-auto w-full text-center">
        <div className="mb-12 relative">
          <div className="absolute -inset-4 bg-primary/20 blur-2xl rounded-full z-0"></div>
          <div className="w-32 h-32 md:w-48 md:h-48 bg-card border-4 border-primary pixel-shadow-primary flex items-center justify-center relative z-10 mx-auto transform -rotate-3">
            <svg 
              width="100%" 
              height="100%" 
              viewBox="0 0 16 16" 
              className="p-4 drop-shadow-[0_0_8px_rgba(255,69,0,0.8)]"
              style={{ imageRendering: 'pixelated' }}
            >
              {/* Giant Lobster ASCII-style SVG */}
              <rect x="2" y="2" width="3" height="4" fill="hsl(var(--primary))" />
              <rect x="11" y="2" width="3" height="4" fill="hsl(var(--primary))" />
              <rect x="3" y="6" width="1" height="3" fill="hsl(var(--primary))" />
              <rect x="12" y="6" width="1" height="3" fill="hsl(var(--primary))" />
              
              <rect x="5" y="4" width="6" height="8" fill="hsl(var(--primary))" />
              <rect x="4" y="12" width="8" height="3" fill="hsl(var(--primary))" />
              <rect x="3" y="14" width="10" height="1" fill="hsl(var(--primary))" />
              
              <rect x="6" y="5" width="2" height="2" fill="white" />
              <rect x="8" y="5" width="2" height="2" fill="white" />
              <rect x="7" y="6" width="1" height="1" fill="black" />
              <rect x="9" y="6" width="1" height="1" fill="black" />
            </svg>
          </div>
        </div>

        <h2 className="font-display text-4xl md:text-6xl text-foreground uppercase mb-6 drop-shadow-md leading-tight">
          Private Agent <br/>
          <span className="text-primary">Control Room</span>
        </h2>
        
        <p className="font-mono text-muted-foreground text-lg md:text-xl max-w-2xl mb-10 leading-relaxed">
          A secure, single-owner facility for autonomous digital crustaceans. Dispatch tasks, monitor approvals, and maintain operational superiority.
        </p>

        {isSignedIn ? (
          <Link href="/office">
            <Button variant="primary" size="lg" className="text-xl px-12 py-6 animate-pulse">
              ENTER OFFICE
            </Button>
          </Link>
        ) : (
          <Link href="/sign-up">
            <Button variant="primary" size="lg" className="text-xl px-12 py-6">
              INITIALIZE WORKSPACE
            </Button>
          </Link>
        )}
      </main>

      <footer className="relative z-10 p-6 border-t-4 border-border text-center text-xs font-mono text-muted-foreground uppercase bg-card/80 backdrop-blur-sm">
        <div>HomardClaw OS v1.0.0 // Authorized Personnel Only // End of Line</div>
      </footer>
    </div>
  );
}
