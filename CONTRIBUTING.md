# Contributing

Install the locked toolchain and run the complete contract suite before opening a pull request:

```bash
npm ci
npm run check
```

Keep the plugin provider- and harness-agnostic. Runtime code may depend on Node builtins and the OpenCode host contract, but the published bundle must not require npm runtime dependencies.
