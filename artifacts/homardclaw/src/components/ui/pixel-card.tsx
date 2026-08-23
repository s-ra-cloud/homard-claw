import React from "react";

export function PixelCard({ 
  children, 
  className = "",
  variant = "default",
  title
}: { 
  children: React.ReactNode; 
  className?: string;
  variant?: "default" | "primary" | "accent" | "destructive";
  title?: React.ReactNode;
}) {
  const baseClass = "bg-card relative";
  
  const borderClasses = {
    default: "border-4 border-border",
    primary: "border-4 border-primary",
    accent: "border-4 border-accent",
    destructive: "border-4 border-destructive"
  };

  const shadowClasses = {
    default: "pixel-shadow",
    primary: "pixel-shadow-primary",
    accent: "pixel-shadow-accent",
    destructive: "pixel-shadow"
  };

  return (
    <div className={`${baseClass} ${borderClasses[variant]} ${shadowClasses[variant]} ${className}`}>
      {title && (
        <div className={`border-b-4 ${borderClasses[variant]} p-3 bg-muted/30`}>
          <div className="font-display text-xs uppercase tracking-tight">{title}</div>
        </div>
      )}
      <div className="p-4">
        {children}
      </div>
    </div>
  );
}
