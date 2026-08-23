import React from "react";
import { useGetProviders } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, AlertTriangle, Server, Network } from "lucide-react";

export default function ProvidersPage() {
  const { data: providers, isLoading } = useGetProviders();

  return (
    <Shell>
      <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6 sm:space-y-8">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-4 border-border pb-6">
          <div>
            <h1 className="font-display text-lg sm:text-2xl text-foreground uppercase mb-2">Network Infrastructure</h1>
            <p className="text-muted-foreground text-sm">LLM Provider connection status and configuration.</p>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[1, 2].map(i => (
              <PixelCard key={i} className="animate-pulse h-48 bg-muted/50">
                <div className="w-full h-full"></div>
              </PixelCard>
            ))}
          </div>
        ) : !providers || providers.length === 0 ? (
          <PixelCard className="text-center p-6 sm:p-12" variant="destructive">
            <Network className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h3 className="font-display text-lg uppercase mb-2">Network Disconnected</h3>
            <p className="text-muted-foreground">Unable to fetch provider status from the mainframe.</p>
          </PixelCard>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {providers.map((provider) => {
              const isReady = provider.configured && provider.healthy;
              
              return (
                <PixelCard 
                  key={provider.provider} 
                  variant={isReady ? "default" : "destructive"}
                  className="flex flex-col h-full"
                >
                  <div className="flex justify-between items-start mb-6">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 border-2 border-border pixel-shadow ${isReady ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                        <Server className="w-6 h-6" />
                      </div>
                      <div>
                        <h3 className="font-display text-lg uppercase">{provider.provider.replace('_', ' ')}</h3>
                      </div>
                    </div>
                    <Badge variant={isReady ? "success" : "destructive"}>
                      {isReady ? "ONLINE" : "OFFLINE"}
                    </Badge>
                  </div>

                  <div className="space-y-4 flex-1 bg-muted/30 p-4 border-2 border-border/50">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold uppercase text-muted-foreground">Configuration</span>
                      {provider.configured ? (
                        <span className="flex items-center text-green-500 text-xs font-bold uppercase"><CheckCircle className="w-3 h-3 mr-1" /> Valid</span>
                      ) : (
                        <span className="flex items-center text-destructive text-xs font-bold uppercase"><AlertTriangle className="w-3 h-3 mr-1" /> Missing API Key</span>
                      )}
                    </div>
                    
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold uppercase text-muted-foreground">Endpoint Health</span>
                      {provider.healthy ? (
                        <span className="flex items-center text-green-500 text-xs font-bold uppercase"><CheckCircle className="w-3 h-3 mr-1" /> Reachable</span>
                      ) : (
                        <span className="flex items-center text-destructive text-xs font-bold uppercase"><AlertTriangle className="w-3 h-3 mr-1" /> Unreachable</span>
                      )}
                    </div>
                    
                    {!isReady && provider.message && (
                      <div className="mt-4 p-2 bg-destructive/10 border-l-4 border-destructive text-xs font-mono text-destructive">
                        {provider.message}
                      </div>
                    )}
                  </div>
                  
                  {!provider.configured && (
                    <div className="mt-4 text-[10px] text-muted-foreground uppercase text-center border-t-2 border-border/30 pt-4">
                      Add the required environment variables in the Replit Secrets tool to enable this provider.
                    </div>
                  )}
                </PixelCard>
              )
            })}
          </div>
        )}
      </div>
    </Shell>
  );
}
