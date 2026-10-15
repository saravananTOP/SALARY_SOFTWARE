# Architecture and domain boundaries

The initial repository is technology-neutral. Preserve these boundaries when selecting a runtime and implementing scripts:

1. **Entry point** — parses arguments, selects a use case, and translates its result into a process exit code.
2. **Application logic** — coordinates a single business operation without depending on a particular command-line, storage, or network library.
3. **Domain rules** — represents validated payroll concepts and deterministic calculations.
4. **Adapters** — handle files, databases, APIs, clocks, and other external systems behind explicit interfaces.

Scripts should be thin entry points that call reusable application logic. Avoid duplicating payroll rules across separate scripts.

## Payroll-specific safeguards

- Represent money with decimal-safe types and explicit currency; define rounding at documented business boundaries.
- Associate rules and employee changes with effective dates. Do not silently apply today's rules to historical payroll periods.
- Validate source records before calculation and report rejected records without exposing unnecessary personal data.
- Make a payroll run traceable to its period, rule/configuration version, and input source. Protect the resulting audit data.
- Design retries and reruns to avoid duplicate payments or writes; require explicit review for irreversible actions.
- Separate calculation from payment or other external side effects.
- Treat tax, statutory deductions, retention, and access requirements as jurisdiction- and organization-specific. Require qualified review before production use.
