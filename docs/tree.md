# pubchem-mcp-server - Directory Structure

Generated on: 2026-03-21 14:26:01

```text
pubchem-mcp-server/
├── .claude/
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── claude-plans/
├── docs/
├── scripts/
│   ├── build.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   └── tree.ts
├── skills/
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── devcheck/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   └── setup/
│       └── SKILL.md
├── src/
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-bioactivity.tool.test.ts
│   │           ├── get-bioactivity.tool.ts
│   │           ├── get-compound-details.tool.test.ts
│   │           ├── get-compound-details.tool.ts
│   │           ├── get-compound-image.tool.test.ts
│   │           ├── get-compound-image.tool.ts
│   │           ├── get-compound-safety.tool.test.ts
│   │           ├── get-compound-safety.tool.ts
│   │           ├── get-compound-xrefs.tool.test.ts
│   │           ├── get-compound-xrefs.tool.ts
│   │           ├── get-summary.tool.test.ts
│   │           ├── get-summary.tool.ts
│   │           ├── index.ts
│   │           ├── search-assays.tool.test.ts
│   │           ├── search-assays.tool.ts
│   │           ├── search-compounds.tool.test.ts
│   │           └── search-compounds.tool.ts
│   ├── services/
│   │   └── pubchem/
│   │       ├── pubchem-client.ts
│   │       └── types.ts
│   └── index.ts
├── .env.example
├── .gitignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
