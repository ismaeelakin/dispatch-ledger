# Contributing

```sh
npm ci
npm run format:check
npm run check
npm test
```

Use `npm run format` after edits. Change `web/app.ts`, not generated `public/app.js`. Builds generate JavaScript and backend output; neither output directory is committed.

For delivery changes, test the failure boundary, not just the successful path. Prefer injected clocks to sleeps. Tenant changes need direct cross-tenant API and database tests. Transport changes should use an actual local HTTP receiver and must not contact external hosts during tests. Never include tokens, database files, master keys or real event payloads in a contribution.
