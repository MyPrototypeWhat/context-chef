---
'@context-chef/core': patch
---

Open the adapter target slot — `chef.compile()` now accepts a custom `ITargetAdapter` without forking the library.

- New `adapterRegistry` singleton (`AdapterRegistry` class) with `register` / `unregister` / `unregisterBySource` / `get` / `has` / `list`. Built-in `openai` / `anthropic` / `gemini` adapters are registered automatically under `sourceId: 'builtin'`.
- New `ChefConfig.defaultTarget?: TargetProvider | ITargetAdapter` — instance-wide default for `compile()` calls without an explicit `target`.
- `compile({ target })` now accepts three forms: built-in literal (precise payload type), registered name (`'cohere'` etc., looked up via the registry), or an `ITargetAdapter` instance (used directly, bypassing the registry — handy for tests and one-offs).
- Resolution order in `compile()`: `options.target` → `this.defaultTarget` → `'openai'` (final fallback, kept for backward compat).
- `TargetProvider` type widened to `BuiltinTargetProvider | (string & {})` — keeps IDE auto-complete on the three built-ins while accepting any registered name.
- `getAdapter()` and `AdapterFactory` exports preserved as thin wrappers over the registry — no breaking change.
- `package.json` gains a `sideEffects` whitelist for `registerBuiltins.*` so future bundler optimizations cannot tree-shake the built-in registrations.

**Note for strict TypeScript consumers**: `TargetProvider` widening from `'openai' | 'anthropic' | 'gemini'` to `BuiltinTargetProvider | (string & {})` is runtime-compatible but defeats exhaustiveness checks. Code that does `switch (t) { case 'openai': … case 'anthropic': … case 'gemini': … }` with no `default` branch and relies on `assertNever(t)` will need to add a `default` clause. Similarly, `CompileOptions.target` moved from required to optional — direct field reads (`opts.target`) now narrow to `TargetProvider | ITargetAdapter | undefined`. No runtime behavior changes for any code path that worked before.
