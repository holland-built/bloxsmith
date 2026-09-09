# Domain Docs

How the engineering skills consume this repo's domain documentation.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`**: the ADRs touching the area you are about to work in

An ADR is an architecture decision record: one short file recording one decision and why.

If these files do not exist, **proceed silently**. Do not flag their absence. The
`/domain-modeling` skill creates them lazily, when terms or decisions actually get resolved.

## Layout

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept, use the term as `CONTEXT.md` defines it. Do not
drift to synonyms.

If a concept is missing from the glossary, that is a signal. Either you are inventing
language the project does not use, or there is a real gap. Note it for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an ADR, say so rather than overriding it silently.
