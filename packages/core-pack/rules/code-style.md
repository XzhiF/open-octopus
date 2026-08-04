# Code Style Rule

This rule enforces consistent code style across the project.

## Guidelines

- Use TypeScript strict mode for all new code
- Prefer `const` over `let`, avoid `var`
- Use descriptive variable and function names
- Add JSDoc comments for public API functions
- Keep functions under 50 lines when possible
- Use early returns to reduce nesting depth
- Prefer named exports over default exports for modules

## Naming Conventions

- **Files**: kebab-case (e.g., `resource-manager.ts`)
- **Types/Interfaces**: PascalCase (e.g., `ResourceEntry`)
- **Variables/Functions**: camelCase (e.g., `getResource`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_RETRIES`)
- **CSS classes**: kebab-case with BEM-like prefixes

## Error Handling

- Always catch and handle errors at module boundaries
- Use typed error classes (e.g., `ResourceError`)
- Include actionable suggestions in error messages
- Log errors with sufficient context for debugging
