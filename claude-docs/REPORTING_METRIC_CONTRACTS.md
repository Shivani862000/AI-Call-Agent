# Reporting Metric Contracts

Prepared 9 September 2026 for P14. These are implementation decisions, not claims that the current reporting code meets them. P10 supplies transport/disposition ownership and P13 supplies durable patient-linked history before integration.

## Period and population

- Calendar periods use `Asia/Kolkata`, with start inclusive and end exclusive. Convert local calendar boundaries to UTC once; SQL uses `timestamp >= start AND timestamp < end`. A calendar week starts Monday. Explicit invalid or reversed ranges are rejected.
- Call-period metrics use `calls.called_at`, one originating call/attempt per row, including retained calls whose queue entry was deleted. Do not join through a required queue row or multiply calls by feedback/event joins.
- Feedback-period metrics use `feedback.submitted_at`. Feedback and call totals therefore have different declared populations; one is not a denominator for the other.
- A current-work backlog is a snapshot at the request's `as_of` time, with its own label. It is not presented as calls created during the selected report period. Obsolete attempts cannot make a newer workflow appear actionable.
- Numeric counts are zero when the verified population is empty. A missing measurement such as rating or spend is `null`, rendered as “Unrated” or “Not available”; it is not evidence of a zero measurement.

## Definitions

| Metric | Population and formula |
| --- | --- |
| Total calls | All call rows in the call period, regardless of analysis status. |
| Answered / completed / failed | Count each call using P10's canonical transport fields and explicit legacy mapping. Disposition is a separate dimension: completion must not erase refusal or callback. Percentages use total calls; an empty denominator displays zero calls and no measured percentage. |
| Feedback count and mean rating | All feedback in the feedback period. A mean includes only observed integer ratings 1–5; no valid observations yields `null`. |
| Sentiment | Count calls for each canonical positive/neutral/negative value. Missing or invalid sentiment is unknown and excluded from those three counts, while remaining in total calls. |
| Recovery cases | A call qualifies if sentiment is negative OR an observed valid rating is 1 or 2. Count a qualifying call once even when both predicates hold. Positive unrated calls do not qualify solely for missing rating. |
| Hot leads | Count calls whose disposition is interested/hot_lead OR whose valid hot-lead score is at least 85, once per call. Use the identical predicate for total and detail queries. |
| Estimated pipeline value | Preserve the existing estimate: sum `hot_lead_score * 10` for interested/hot_lead calls across the full period. Label it an estimate. Do not represent missing scores as measured revenue or read a queue revenue field from `calls`. |
| Objections / competitors | Aggregate normalized nonempty labels across the complete call period, counting a label at most once per call. Invalid historical JSON contributes no labels and does not abort the report; preserve a diagnostic count. Bound the displayed labels separately. |
| Callback requests | Period count of calls carrying callback disposition. Distinct from the currently actionable callback backlog. |
| Callback backlog / owner alerts / complaints | Count the complete declared actionable population at `as_of`, using durable ownership and current state. Fetch bounded matching detail rows separately. No total derives from a truncated array. |

## Detail lists and consumers

Each bounded list exposes its total and limit, and uses a stable timestamp/ID order. Retain the existing staff-facing bounds (for example six recovery cases and 25 recent calls) unless P16 explicitly changes the paging contract. The API, dashboard, digest and PDF must use the same total/predicate and label a partial list accordingly.

Detail queries include the fields their consumer renders: durable patient name, originating timestamp, summary/excerpt, observed rating, score, follow-up and next action. Apply the access policy before exposing contacts or free text. Detail bounds never constrain an aggregate query, and full history must not be loaded into JavaScript to calculate totals.

## Required evidence

P14's disposable database fixture exceeds both the 25-call and six-recovery display bounds. Include an older high-value/negative call, a positive unrated call, invalid historical JSON/rating values, a call with both recovery predicates, queue-deleted history, duplicate feedback/event joins and adjacent IST midnight/week boundaries. Assert exact SQL totals and independently bounded details through both report builders, then capture dashboard/digest/PDF outputs without delivering a notification. Record actual results in the remediation evidence register; this contract alone closes no finding.
