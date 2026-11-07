# Email Risk Analyzer

A Gmail add-on that analyzes the email currently open in Gmail and shows a maliciousness score, a short verdict, and the reasoning behind it.

The score is a model-generated risk assessment from 0 to 100. A higher score means the message looks more suspicious. It is not a calibrated probability, and a low score does not mean the email is safe.

## What the user sees

Opening an email, or switching to another one, runs the add-on again. The Gmail sidebar shows:

- A score and one of three verdicts: `Low risk`, `Suspicious`, or `High risk`.
- A one- or two-sentence explanation.
- Evidence taken from the supplied email.
- A recommended next step. High-risk and suspicious messages tell the user to pause and verify through a known channel. A low-risk message says that no strong warning signs were found in the supplied content, and that this does not guarantee safety.
- A collapsible list of checks the analysis did not perform.
- The subject, sender, and a short body preview.

If no email is open, the add-on asks the user to open one. It does not call the backend. If the backend request fails, times out, or returns an unexpected response, the card says **Backend unavailable** and states that no risk assessment was produced. It does not show a score of zero or a reassuring verdict.

## Architecture

```text
Gmail
  -> Apps Script add-on
  -> HTTPS POST /analyze
  -> FastAPI on FastAPI Cloud
  -> one GPT-6 Luna request
  -> structured assessment
  -> Gmail card
```

The add-on is the product. It reads the opened message and renders the card. The backend owns the OpenAI API key, validates the request, and makes the model call. The key never goes to Apps Script or the browser.

The deployed backend used for the live demo is:

```text
https://email-risk-analyzer.fastapicloud.dev
```

`GET /health` checks that the service is up and does not call OpenAI. `POST /analyze` performs the assessment.

## What is sent to the model

For each opened message, the add-on sends:

- Subject, truncated to 500 characters.
- Displayed sender, truncated to 500 characters.
- Reply-to address, when present.
- The first 20,000 characters of the plain-text body.
- Up to 30 `http` and `https` links extracted from the HTML and plain text.

The email JSON is labeled as untrusted evidence. Instructions inside the email cannot change the task or the output format.

The add-on does not send recipients, authentication headers, attachment bytes, or attachment metadata. The model is instructed not to claim that it opened attachments, visited links, checked link or domain reputation, or verified the sender. `store` is set to `false` on the OpenAI request.

## How the assessment is produced

There is one model call per email, using OpenAI's Responses API and the model ID `gpt-6-luna`. The response is constrained to this schema:

- `risk_score`: integer from 0 to 100.
- `verdict`: `Low risk`, `Suspicious`, or `High risk`.
- `explanation`: short text.
- `evidence`: one to five items.
- `limitations`: one to five items.

The model produces both the score and the verdict. There is no second scoring formula, rules engine, or model. FastAPI validates the structured result before returning it. An API error, timeout, or empty structured result becomes HTTP 502 with `Email analysis unavailable.`

## Security

Email content, model output, and the public HTTP request are treated as untrusted.

- `POST /analyze` requires an `X-Addon-Token` header. The backend compares it with `ADDON_API_TOKEN` using a constant-time comparison. A missing or wrong token returns 401 before OpenAI is called.
- The OpenAI key and the add-on token are separate secrets. The add-on stores only the add-on token, in Apps Script Script Properties. It is not written in `code.gs`.
- Locally, both secrets live in `backend/.env`, which is gitignored. The repository contains `backend/.env.example` with placeholders only.
- On FastAPI Cloud, both values are stored as encrypted environment secrets. `.fastapicloudignore` excludes `.env`.
- The add-on may call only `https://email-risk-analyzer.fastapicloud.dev/`, listed in `urlFetchWhitelist`.
- Requested OAuth scopes are `gmail.addons.execute`, `gmail.addons.current.message.readonly`, and `script.external_request`.
- Field lengths are capped. Email text is escaped before it is placed in the card.

The shared token is appropriate for this single-user demonstration. Anyone who obtains it can call the backend. A multi-user product should verify a Google identity token and add per-user limits. The public URL is not a secret.

## Repository layout

```text
addon/                 Apps Script add-on
backend/               FastAPI service, tests, and evaluation runner
samples/               Synthetic emails and recorded evaluation results
EVALUATION.md          What the evaluation showed
README.md              This file
```

The Apps Script project is updated by copying `addon/code.gs` and `addon/appsscript.json` into the Apps Script editor. This repository does not use clasp.

## Run the backend locally

Requirements: Python 3.10 or newer, and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env`:

```text
OPENAI_API_KEY=your-openai-api-key
ADDON_API_TOKEN=a-long-random-token
```

Generate the token with `openssl rand -hex 32`. Then:

```bash
uv sync
uv run fastapi dev --no-reload
```

The API listens at `http://127.0.0.1:8000`. Check it with:

```bash
curl http://127.0.0.1:8000/health
```

An analysis request must include the same token:

```bash
curl -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -H "X-Addon-Token: $ADDON_API_TOKEN" \
  --data-binary @../samples/legitimate-email.json
```

A request without that header returns `{"detail":"Unauthorized."}`.

Automated tests mock OpenAI and do not spend API credit:

```bash
uv run pytest
```

## Deploy the backend

The demo deployment is a FastAPI Cloud Hobby app named `email-risk-analyzer`. From `backend/`, after `uv sync`:

```bash
uv run fastapi login
uv run fastapi deploy
uv run fastapi cloud env set --secret OPENAI_API_KEY
uv run fastapi cloud env set --secret ADDON_API_TOKEN
uv run fastapi deploy
```

The second deploy is required because environment changes apply on the next deployment. Setting a secret prompts for the value and does not print it. `.env` is not uploaded.

If you deploy your own copy, change `BACKEND_ANALYZE_URL` in `addon/code.gs` and the matching prefix in `addon/appsscript.json`.

## Install the Gmail add-on

1. Create a Google Apps Script project bound to a Gmail add-on.
2. Paste `addon/code.gs` into `Code.gs` and `addon/appsscript.json` into the manifest.
3. In Project Settings, add a script property named `ADDON_API_TOKEN` with the same value stored in the backend.
4. Save and create a test deployment.
5. Install that deployment for the Gmail account used in the demo.
6. Open Gmail, open a message, and open the Email Risk Analyzer sidebar.

The first run asks for permission to read the current message and to connect to an external service. Use a message you are willing to send to OpenAI. The selected fields leave Google Apps Script, pass through the backend, and are sent to the model.

## Evaluation

`samples/` contains eight synthetic emails: an ordinary meeting update, a marketing newsletter, a password-reset notice, credential phishing, a business-email-compromise payment request, an invoice with new bank details, a message that claims an executable attachment, and a phishing email that tries to override the model instructions.

`EVALUATION.md` records one live run against the deployed endpoint. Clear phishing and payment-diversion messages scored high. The marketing newsletter stayed low risk. The prompt-injection text did not force a low score or a claim that the sender had been verified.

Two results differed from the cautious labels I expected:

- The polite password-reset email was scored 16, `Low risk`. The wording looks routine, and the system cannot tell a real reset page from a lookalike.
- The executable-attachment lure was scored 96, `High risk`. The filename was visible in the body, but the file itself was not received or scanned.

To repeat the live run, from `backend/`:

```bash
uv run python evaluate.py
```

Each sample makes one paid model call. The script writes `samples/evaluation-results.json`.

## Decisions and limits

I kept one inexpensive model call so the result would be easy to inspect and explain. The first weakness that showed up is content that looks normal. A password-reset email and a real account-takeover email can use similar language, and this system cannot check SPF, DKIM, DMARC, or link reputation.

The add-on therefore shows limitations and never calls a message safe. That is a product choice: the card should help someone decide what to do next, not pretend to be a mail gateway.

With more time I would:

- Send attachment metadata: filename, MIME type, and size.
- Include SPF, DKIM, and DMARC results when Gmail exposes them.
- Add a small caution for password-reset and payment-change messages when sender authenticity is unknown, still using one model call.
- Replace the shared demo token with Google identity verification and per-user limits.

I would not add a second model, a trained classifier, or a large rules engine until those missing signals were measured against the current baseline.

## Live demo

1. Open Gmail with the test deployment installed.
2. Show the homepage with no message selected.
3. Open an ordinary message and a suspicious message.
4. Walk through the score, evidence, guidance, and the checks that were not performed.
5. Show that stopping a laptop process is unnecessary: the backend is the FastAPI Cloud service, not a local server.
