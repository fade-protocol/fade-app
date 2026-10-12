// The generated client reads `process.env.NODE_ENV` at module load to decide
// whether to bundle its error messages. Browsers have no `process`: give it
// one before anything imports the client. Error texts shown to users come from
// the program's own logs (lib/tx.ts), so this value only has to exist.
const g = globalThis as { process?: { env: Record<string, string | undefined> } };
g.process ??= { env: { NODE_ENV: "production" } };

export {};
