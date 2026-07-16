// Helper process spawned by verify-background-runtime.ts, not a standalone
// verify script itself (hence the leading underscore, excluding it from the
// normal scripts/verify-*.ts convention). It starts a BackgroundRuntime with
// zero workers and deliberately never calls stop() or does anything else —
// if BackgroundRuntime's own keep-alive handle is working, this process
// stays alive indefinitely on its own; if that guarantee ever regresses, this
// process exits almost immediately since nothing else here holds it open.
import { BackgroundRuntime } from "../src/runtime/BackgroundRuntime";

const runtime = new BackgroundRuntime([]);
runtime.start();
console.log("child: started, no workers, never stopping on purpose");
