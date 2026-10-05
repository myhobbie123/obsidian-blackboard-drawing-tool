# Contributing to Blackboard Drawing Tool

Report bugs and propose changes in [the fork repository](https://github.com/myhobbie123/obsidian-blackboard-drawing-tool). Keep pull requests focused and describe the resulting behavior.

Use Node.js 24 (see `.nvmrc`):

```sh
git clone https://github.com/myhobbie123/obsidian-blackboard-drawing-tool.git
cd obsidian-blackboard-drawing-tool
npm ci
npm run check
```

`npm run check` runs typechecking, lint, unit tests, and a production build. Use `npm run dev` for a development build, `npm test` for unit tests, and `npm run test:watch` for test watch mode. Development builds include a local reload bridge; use production assets for manual release testing.

Follow the existing TypeScript style and add focused tests for behavior changes. Describe manual device testing when a change affects stylus input or mobile rendering. Do not commit generated `main.js`, release assets, plugin settings, or vault data.

Use short English commit messages. See [README.md](README.md#releasing) for the maintainer's release steps. Version scripts do not push automatically.
