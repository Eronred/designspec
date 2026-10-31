---
name: Button
source: src/components/ui/button.tsx
import: "@/components/ui/button"
exports: [ Button, buttonVariants ]
variants:
  buttonVariants:
    variant: [ default, destructive, outline, ghost, link ]
    size: [ default, sm, lg, icon ]
  Button:
    variant: [ default, destructive, outline, ghost, link ]
    size: [ default, sm, lg, icon ]
defaults:
  buttonVariants:
    variant: default
    size: default
  Button:
    variant: default
    size: default
controls:
  buttonVariants:
    size: [ height, padding, radius ]
  Button:
    size: [ height, padding, radius ]
replaces: [ button ]
---

# Button

<!-- When should this component be used, and when not? AI agents read this before building UI. -->

## Usage

```tsx
import { Button } from "@/components/ui/button"
```
