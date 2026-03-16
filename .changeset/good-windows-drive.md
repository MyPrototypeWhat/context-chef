---
"context-chef": patch
---

Fix `objectToXml` losing array field names and breaking indentation

When an object contained an array field (e.g. `{ tasks: [{...}, {...}] }`), the key name was discarded and items were output as bare `<item>` tags without a wrapper. Now arrays are wrapped in their field name tag with properly indented items:

```xml
<!-- Before: key "tasks" lost, indentation broken -->
<item><name>Task 1</name></item>
<item><name>Task 2</name></item>

<!-- After: key preserved as wrapper tag -->
<tasks>
  <item><name>Task 1</name></item>
  <item><name>Task 2</name></item>
</tasks>
```
