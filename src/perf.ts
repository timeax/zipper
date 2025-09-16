// src/perf.ts
import pc from "picocolors";

export type Perf = {
   mark(label: string): void;
   measure(label: string): void;
   done(totalLabel?: string): void;
   enabled: boolean;
};

export function makePerf(enabled = process.env.ZIPPER_TIMING === "1"): Perf {
   const t0 = Date.now();
   let last = t0;
   return {
      enabled,
      mark(_label) { last = Date.now(); },
      measure(label) {
         if (!enabled) return;
         const now = Date.now();
         const dt = now - last;
         console.log(pc.dim(`[timing] ${label}: ${dt}ms`));
         last = now;
      },
      done(totalLabel = "total") {
         if (!enabled) return;
         const now = Date.now();
         console.log(pc.dim(`[timing] ${totalLabel}: ${now - t0}ms`));
      }
   };
}