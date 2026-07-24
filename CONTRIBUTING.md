# Contributing

Thank you for helping improve `email-mcp-server`.

## Development

Use Node.js 22.18 or later. Fork the repository, create a focused branch, and install the locked
dependencies:

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

Keep real credentials and deployment identifiers out of commits. `wrangler.toml` is the public,
sanitized configuration. Use the ignored `wrangler.production.toml` for a real deployment.

Before opening a pull request, run:

```bash
npm run format:check
npm run lint
npm run type-check
npm test
npm run cf-typegen:check
npm run public-config:check
```

MCP tool names, descriptions, schemas, annotations, and structured outputs are public interfaces.
Changes to them should be intentional, documented in the pull request, and covered by tests.

## Pull requests

Keep changes narrow, explain their user impact, and add tests for behavior changes. Do not include
mailbox data, access tokens, account identifiers, screenshots containing private data, or generated
deployment configuration.

By contributing, you agree that your contribution is licensed under the MIT License.
