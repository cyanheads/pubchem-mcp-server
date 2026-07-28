# pubchem-mcp-server - Directory Structure

Generated on: 2026-07-28 16:29:23

```text
pubchem-mcp-server/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   └── template.md
├── claude-plans/
├── docs/
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
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
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
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
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── assay.resource.ts
│   │   │       ├── compound-bioactivity.resource.ts
│   │   │       ├── compound-image.resource.ts
│   │   │       ├── compound-safety.resource.ts
│   │   │       ├── compound-xrefs.resource.ts
│   │   │       ├── compound.resource.ts
│   │   │       └── index.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-bioactivity.tool.ts
│   │           ├── get-compound-3d-structure.tool.ts
│   │           ├── get-compound-details.tool.ts
│   │           ├── get-compound-image.tool.ts
│   │           ├── get-compound-interactions.tool.ts
│   │           ├── get-compound-safety.tool.ts
│   │           ├── get-compound-xrefs.tool.ts
│   │           ├── get-summary.tool.ts
│   │           ├── index.ts
│   │           ├── search-assays.tool.ts
│   │           ├── search-compounds.tool.ts
│   │           └── untrusted-text.ts
│   ├── services/
│   │   └── pubchem/
│   │       ├── pubchem-client.ts
│   │       ├── sdf-parser.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── assay.resource.test.ts
│   │   │       ├── compound-image.resource.test.ts
│   │   │       ├── compound-safety.resource.test.ts
│   │   │       └── compound.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-bioactivity-extended.tool.test.ts
│   │           ├── get-bioactivity.tool.test.ts
│   │           ├── get-compound-3d-structure.tool.test.ts
│   │           ├── get-compound-details-extended.tool.test.ts
│   │           ├── get-compound-details.tool.test.ts
│   │           ├── get-compound-image-extended.tool.test.ts
│   │           ├── get-compound-image.tool.test.ts
│   │           ├── get-compound-interactions-extended.tool.test.ts
│   │           ├── get-compound-interactions.tool.test.ts
│   │           ├── get-compound-safety-extended.tool.test.ts
│   │           ├── get-compound-safety.tool.test.ts
│   │           ├── get-compound-xrefs-extended.tool.test.ts
│   │           ├── get-compound-xrefs.tool.test.ts
│   │           ├── get-summary-extended.tool.test.ts
│   │           ├── get-summary.tool.test.ts
│   │           ├── search-assays-extended.tool.test.ts
│   │           ├── search-assays.tool.test.ts
│   │           ├── search-compounds-extended.tool.test.ts
│   │           ├── search-compounds.tool.test.ts
│   │           └── untrusted-text.test.ts
│   └── services/
│       └── pubchem/
│           ├── pubchem-client-extended.test.ts
│           ├── pubchem-client-interactions.test.ts
│           ├── pubchem-client.test.ts
│           └── sdf-parser.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
