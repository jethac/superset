# JavaScript to TypeScript Migration Project

**Status: complete for application code. This playbook is kept for reference, not as an active work queue.**

The frontend application code is TypeScript. Measured with `git ls-files` over
`superset-frontend/src`, `superset-frontend/packages` and
`superset-frontend/plugins`:

- 3,723 tracked `.ts`/`.tsx` files
- 6 tracked `.js` files, 0 tracked `.jsx` files
- `superset-frontend/src` contains 0 tracked `.js`/`.jsx` files

```bash
cd superset-frontend
git ls-files 'src/**' 'packages/**' 'plugins/**' | grep -cE '\.(js|jsx)$'
git ls-files 'src/**' 'packages/**' 'plugins/**' | grep -cE '\.(ts|tsx)$'
```

The six remaining files are Yeoman generator code, a Jest config and test
mocks, none of which are application source:

- `packages/generator-superset/generators/app/index.js`
- `packages/generator-superset/generators/plugin-chart/index.js`
- `packages/generator-superset/generators/plugin-chart/templates/test/__mocks__/mockExportString.js`
- `packages/generator-superset/jest.config.js`
- `packages/superset-ui-core/__mocks__/mockExportObject.js`
- `packages/superset-ui-core/__mocks__/mockExportString.js`

Build output under `lib/` and `esm/` is JavaScript by design and is not in
scope. Directories outside the three above (for example `cypress-base` and
`spec`) were not measured here.

Do not start new migration work from this document. The standing rule that new
frontend code is written in TypeScript lives in [AGENTS.md](../../../AGENTS.md).

## 📁 Project Documentation

- **[AGENT.md](./AGENT.md)** - Technical migration guide for agents (type reference, patterns, validation)
- **[COORDINATOR.md](./COORDINATOR.md)** - Coordinator workflow (file selection, task management, integration)

Both describe how the migration was run. They apply only if a JS/JSX file
appears in application code again.

---

*Documentation and coordination resources for this refactor are organized under `.claude/projects/js-to-ts/`*
