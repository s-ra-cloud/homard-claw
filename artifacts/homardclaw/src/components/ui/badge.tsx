import React from "react";
import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "primary" | "accent" | "destructive" | "outline" | "success" | "warning";
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const variants = {
    default: "bg-secondary text-secondary-foreground border-2 border-border",
    primary: "bg-primary text-primary-foreground border-2 border-primary",
    accent: "bg-accent text-accent-foreground border-2 border-accent",
    destructive: "bg-destructive text-destructive-foreground border-2 border-destructive",
    success: "bg-green-500 text-white border-2 border-green-700",
    warning: "bg-yellow-500 text-black border-2 border-yellow-700",
    outline: "text-foreground border-2 border-border",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}
