# 04 — Review Gate Mechanism

Type: grilling
Status: resolved

## Question
How should evolution patches be validated before application?

## Answer
Adversarial review — another system_agent node acts as reviewer:

1. **Generator agent** produces the patch (old_str → new_str)
2. **Reviewer agent** examines with opposing perspective:
   - Does this fix the identified failure?
   - Does it preserve existing correct behavior?
   - Is the patch minimal and traceable?
3. **If rejected**: rejection feedback feeds back to the generator for revision
4. **If accepted**: patch is applied with backup

Based on hermes-self-evolution's iterative adversarial review pattern.

**Reason**: Self-review is unreliable (agent approves its own changes). Adversarial review catches regressions and over-fitting.
