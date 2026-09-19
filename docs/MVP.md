# MVP acceptance criteria

1. A caller can submit each of the four artifact types and receive a bounded score and explainable decision.
2. A suspicious earlier action can increase scrutiny of a later, different artifact type in the same session; independent sessions remain isolated.
3. Policy changes affect new evaluations without rewriting historical decisions.
4. A held request can receive one recorded human resolution.
5. Evaluations survive server restart and are exportable with audit receipts.
6. The console supports filtering, inspection, evaluation, scenario replay, policy editing, and review.
7. Invalid inputs fail cleanly. The API never executes or fetches submitted artifacts.
8. Synthetic fixtures, caller-provided evidence, and production limitations are explicit.

The implementation follows the supplied project brief's unified defensive scoring concept while reducing the research and integration scope to a demonstrable local application.
