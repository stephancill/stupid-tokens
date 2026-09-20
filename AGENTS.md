# Project instructions

- Read `docs/architecture.md` and `docs/implementation-notes.md` before changing the implementation. Check other relevant planning documents in `docs/` too.
- Update `docs/implementation-notes.md` when behavior, operations, or architecture changes, and before committing. Keep notes free of personal information.
- Use Bun, TypeScript, Hono, Zod, Cloudflare Workers, D1, and SQLite-backed Durable Objects. Use the existing lockfile.
- Prefer functions and named parameter objects. Classes are limited to platform-required Durable Objects.
- Validate external requests and upstream data with Zod. Normalize EVM addresses to lowercase; identity is chain ID plus address. Never identify tokens by symbol.
- Prices are USD. Refresh on demand only, at most one upstream attempt per asset in a rolling 300-second interval, shared across callers and deployments. Persist refresh reservations before contacting the upstream.
- Search matches name, symbol, or exact address, and sorts by stored market cap descending before limiting. Unknown caps sort last. Keep source timestamps distinct from fetch timestamps.
- Never forward user search queries upstream. Keep cached read traffic off the refresh coordinator whenever possible.
- Secrets belong in ignored `.env.local` for development and Wrangler secrets in production.
- Keep documentation in `docs/`, except this file.
- After TypeScript changes run `bun run format`, `bun run lint`, and `bun run typecheck`. Run relevant Workers-runtime tests and `bun run build` for runtime changes.
