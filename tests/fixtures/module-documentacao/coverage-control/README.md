```mermaid
flowchart LR
A["src/api.ts"] --> B["src/billing.ts"] --> C["src/third.ts"]
%% B["src/legacy.ts"]
T["src/api.test.ts"] --> B
```
