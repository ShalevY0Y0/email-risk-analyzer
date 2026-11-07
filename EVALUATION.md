# Evaluation notes

This is a qualitative check of one GPT-6 Luna request per email. Scores are model-generated risk assessments, not calibrated probabilities. The automated tests mock OpenAI and do not spend API credit.

## Method

Eight synthetic emails were posted to the deployed `POST /analyze` endpoint. Each request used the same prompt, structured-output schema, and add-on token. No attachments were scanned, and no link or sender reputation lookup was performed.

Expected verdicts are reviewer judgments about what a cautious product should show. They are not a scoring formula.

## Results

| Sample | Purpose | Expected | Actual | Score |
| --- | --- | --- | --- | --- |
| Routine meeting | Ordinary work email | Low risk | Low risk | 8 |
| Marketing newsletter | Commercial urgency | Low risk | Low risk | 14 |
| Password reset | Looks legitimate, unverified | Suspicious | Low risk | 16 |
| Credential phishing | Password plus urgency | High risk | High risk | 94 |
| BEC payment | Executive wire request | High risk | High risk | 96 |
| Invoice fraud | New bank details | High risk | High risk | 79 |
| Attachment lure | `.exe` presented as a contract | Suspicious | High risk | 96 |
| Prompt injection | Instruction override plus phishing | High risk | High risk | 94 |

The recorded JSON is in `samples/evaluation-results.json`.

## What worked

- Clear phishing, payment diversion, and invoice-change emails received high scores with evidence taken from the supplied text.
- The marketing newsletter stayed low risk despite sale urgency.
- The prompt-injection sample was treated as untrusted email content. The model did not adopt `risk_score 0` or claim it had verified the sender.
- Explanations named missing checks: sender identity, link destination, headers, and attachments.

## Observed weaknesses

- **Password resets look benign.** A well-written reset notice scored 16 / Low risk because the text itself is polite and expected. Content-only analysis cannot tell a real reset from a lookalike page.
- **Attachment handling is incomplete.** The model reacted strongly to `Contract-Final.exe` in the body, which is useful, but it still has no filename, MIME type, size, or file contents from Gmail.
- **Scores are not comparable as probabilities.** Invoice fraud (79) and credential phishing (94) are both high risk, but the numbers should not be read as 79% versus 94% likelihood.
- **Authentication headers are absent.** SPF, DKIM, and DMARC results would help on password resets and lookalike senders.

## What I would improve next

1. Send attachment metadata: filename, MIME type, and size.
2. Include SPF/DKIM/DMARC results when Gmail provides them.
3. Keep a single model call, then add a small post-check that raises caution on password-reset and payment-change emails until sender authenticity is known.
4. Expand the set with bilingual emails and lookalike domains.

These changes stay within the current architecture. They do not require a second model, training, or a custom scoring engine.
