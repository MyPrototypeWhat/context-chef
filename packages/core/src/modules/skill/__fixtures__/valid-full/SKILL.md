---
name: db-debug
description: Diagnose database query and connection issues
whenToUse: When the user reports slow SQL, connection errors, or ORM exceptions
allowedTools: [query_db, tail_logs, read_file, grep]
---

Diagnostic steps:
1. First confirm DB connectivity: `pg_isready` or `SELECT 1`
2. Check slow query log: `tail_logs --service=postgres --filter=slow`
3. Pull related code to inspect ORM config

References:
- ./docs/db-schema.md
- ./docs/common-issues.md
