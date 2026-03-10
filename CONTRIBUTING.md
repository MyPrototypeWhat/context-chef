# Contributing to ContextChef

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/MyPrototypeWhat/context-chef.git
cd context-chef

# Install dependencies
pnpm install

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint

# Build
pnpm build
```

## Project Structure

```
src/
├── adapters/       # Provider-specific adapters (OpenAI, Anthropic, Gemini)
├── core/           # Core interfaces
├── modules/
│   ├── assembler/  # Message assembly and stitching
│   ├── guardrail/  # Output format constraints
│   ├── janitor/    # History compression
│   ├── memory/     # Core memory with KV store
│   ├── offloader/  # VFS (virtual file system)
│   └── pruner/     # Tool management and filtering
├── types/          # TypeScript type definitions
├── utils/          # Utilities
├── prompts.ts      # System prompt templates
└── index.ts        # Main ContextChef class
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests as needed
4. Ensure all checks pass:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   ```
5. Submit a pull request

## Code Style

- We use [Biome](https://biomejs.dev/) for formatting and linting
- Run `pnpm lint:fix` to auto-fix issues
- Use single quotes, no semicolons optional (Biome handles this)

## Commit Messages

Use clear, descriptive commit messages:

- `Add <feature>` for new features
- `Fix <issue>` for bug fixes
- `Refactor <area>` for code improvements
- `Update <area>` for enhancements

## Reporting Bugs

Use the [bug report template](https://github.com/MyPrototypeWhat/context-chef/issues/new?template=bug_report.md) to report issues.

## License

By contributing, you agree that your contributions will be licensed under the ISC License.
