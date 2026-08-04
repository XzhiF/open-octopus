# Code Review Command

Perform a comprehensive code review of the specified files or changes.

## Usage

```
/review [file-or-directory]
```

## Review Checklist

When reviewing code, check for:

1. **Correctness** — Does the code do what it claims?
2. **Type Safety** — Are types properly defined? Any `any` escapes?
3. **Error Handling** — Are errors caught and handled appropriately?
4. **Security** — Input validation, path traversal, injection risks?
5. **Performance** — Unnecessary loops, N+1 queries, memory leaks?
6. **Readability** — Clear naming, appropriate comments, logical structure?
7. **Testing** — Are critical paths tested? Edge cases covered?
8. **Documentation** — Public APIs documented? Complex logic explained?

## Output Format

```
## Review Summary

### Issues Found
- 🔴 Critical: [description]
- 🟡 Warning: [description]
- 🔵 Suggestion: [description]

### Positive Aspects
- [what's done well]

### Recommendations
1. [actionable recommendation]
```

## Instructions

1. Read the specified file(s) or git diff
2. Analyze each file against the checklist above
3. Provide specific line references for issues
4. Suggest concrete improvements with code examples
5. Summarize overall quality assessment
