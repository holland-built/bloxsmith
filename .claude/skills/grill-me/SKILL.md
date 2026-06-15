---
name: grill-me
description: Pre-build planning interview. Relentlessly extracts what's in your head — design decisions, edge cases, constraints, open questions — one question at a time, before any code. Activate on "grill me", "/grill-me", "help me think through", "plan before we build", "interview me about".
user-invocable: true
argument-hint: "[describe the feature, system, or decision to plan]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

Planning topic: $ARGUMENTS

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. For each question, provide your recommended answer. Ask questions **one at a time**.

If a question can be answered by exploring the codebase, explore it instead of asking.

---

## Checkpointing rule

After every answer, append it to `brainstorms/<topic-slug>-<YYYY-MM-DD>.md` (create the file and `brainstorms/` dir if needed). Format:

```markdown
# <topic> — <date>

## Decisions
- <decision>: <answer>

## Open flags
- <thing user couldn't answer / needs to look up>

## Q&A log
**Q:** <question>
**A:** <answer>

---
```

This guards against the model misremembering early answers as the context window fills.

---

## When to stop

Stop grilling when:
1. Every significant branch of the decision tree has a committed answer, OR
2. The user says "done" or "enough"

Then produce a **final summary** in the brainstorm file:
- All committed decisions
- Open flags (things to look up or ask a stakeholder)
- Recommended next steps

---

**Rule:** The fix for misalignment is friction applied to *you*, not the model. Friction here = questions you answer before a line of code is written. Front-loading this jumps first-iteration success from ~70% to ~90%.

---

## Independent Pre-Read Rule

Before the first question, **do not parrot the user's problem statement back.** Instead:
1. Read relevant code sections in `index.html` and `server.py` independently.
2. Form your own diagnosis — what does the evidence say the actual problem is?
3. State your independent read *before* asking Q1: "Here's what I see in the code: [X]. My working theory is [Y]. Now let me probe the gaps..."
4. If your read differs from the user's description, name the conflict explicitly and ask about it first.

User problem descriptions are starting hypotheses, not specifications. The interview sharpens the real diagnosis — it doesn't rubber-stamp the initial complaint.
