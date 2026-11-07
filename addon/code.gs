const BACKEND_ANALYZE_URL =
  "https://email-risk-analyzer.fastapicloud.dev/analyze";
const ADDON_TOKEN_PROPERTY = "ADDON_API_TOKEN";
const ADDON_LOGO_URL =
  "https://www.gstatic.com/images/icons/material/system/1x/security_black_48dp.png";

function onHomepage() {
  const header = CardService.newCardHeader()
    .setTitle("Email Risk Analyzer")
    .setSubtitle("Ready when you open a message")
    .setImageUrl(ADDON_LOGO_URL)
    .setImageAltText("Security shield")
    .setImageStyle(CardService.ImageStyle.SQUARE);

  const section = CardService.newCardSection()
    .addWidget(
      CardService.newDecoratedText()
        .setTopLabel("No email selected")
        .setText("<b>Open an email to analyze it</b>")
        .setBottomLabel(
          "The analyzer runs only on the currently opened message."
        )
        .setWrapText(true)
    )
    .addWidget(
      CardService.newTextParagraph()
        .setText(
          "When a message is open, this add-on shows an AI-generated risk " +
          "assessment, supporting evidence, limitations, and safer next steps."
        )
    )
    .addWidget(
      CardService.newTextParagraph()
        .setText(
          '<font color="#5f6368">' +
          "Results are advisory and do not guarantee that an email is safe." +
          "</font>"
        )
    );

  return CardService.newCardBuilder()
    .setHeader(header)
    .addSection(section)
    .build();
}

function onEmailOpened(e) {
  // Activate the temporary access Google provides.
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);

  // Retrieve the specific message identified by Gmail.
  const message = GmailApp.getMessageById(e.gmail.messageId);

  const subject = message.getSubject() || "(No subject)";
  const sender = message.getFrom();
  const body = message.getPlainBody();
  const preview = body.slice(0, 500) +
    (body.length > 500 ? "…" : "");
  const assessment = getEmailAssessment({
    subject: subject.slice(0, 500),
    sender: sender.slice(0, 500),
    reply_to: (message.getReplyTo() || "").slice(0, 500) || null,
    body: body.slice(0, 20000),
    links: extractLinks(message.getBody(), body)
  });

  const emailSection = CardService.newCardSection()
    .setHeader("Email details")
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(2)
    .addWidget(
      CardService.newDecoratedText()
        .setTopLabel("Subject")
        .setText(escapeText(subject))
        .setWrapText(true)
    )
    .addWidget(
      CardService.newDecoratedText()
        .setTopLabel("From")
        .setText(escapeText(sender))
        .setWrapText(true)
    )
    .addWidget(
      CardService.newTextParagraph()
        .setText(
          "<b>Message preview</b><br>" +
          escapeText(preview || "(No text content)")
            .replace(/\r?\n/g, "<br>")
        )
    );

  const cardBuilder = CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader()
        .setTitle("Email Risk Analyzer")
        .setSubtitle("Analysis of the opened message")
        .setImageUrl(ADDON_LOGO_URL)
        .setImageAltText("Security shield")
        .setImageStyle(CardService.ImageStyle.SQUARE)
    );
  buildAssessmentSections(assessment).forEach(function(section) {
    cardBuilder.addSection(section);
  });

  return cardBuilder
    .addSection(emailSection)
    .build();
}

function getEmailAssessment(emailData) {
  try {
    const addonToken = PropertiesService.getScriptProperties()
      .getProperty(ADDON_TOKEN_PROPERTY);

    if (!addonToken) {
      console.error("ADDON_API_TOKEN script property is not configured.");
      return null;
    }

    const response = UrlFetchApp.fetch(BACKEND_ANALYZE_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(emailData),
      headers: {
        "Cache-Control": "no-cache",
        "X-Addon-Token": addonToken
      },
      timeoutSeconds: 40,
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      console.error(
        "Backend request returned HTTP " + response.getResponseCode()
      );
      return null;
    }

    const data = JSON.parse(response.getContentText());
    const validVerdicts = ["Low risk", "Suspicious", "High risk"];
    const isValid =
      Number.isInteger(data.risk_score) &&
      data.risk_score >= 0 &&
      data.risk_score <= 100 &&
      validVerdicts.indexOf(data.verdict) !== -1 &&
      typeof data.explanation === "string" &&
      Array.isArray(data.evidence) &&
      Array.isArray(data.limitations);

    if (!isValid) {
      console.error("Backend response did not match the expected format.");
      return null;
    }

    console.log("Email analysis request succeeded.");
    return data;
  } catch (error) {
    console.error("Backend request failed: " + error);
    return null;
  }
}

function buildAssessmentSections(assessment) {
  const assessmentSection = CardService.newCardSection()
    .setHeader("Email risk assessment");

  if (!assessment) {
    return [
      assessmentSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel("Analysis status")
          .setText("<b>Backend unavailable</b>")
          .setBottomLabel("No risk assessment was produced.")
      )
    ];
  }

  const verdictColor = getVerdictColor(assessment.verdict);

  assessmentSection
    .addWidget(
      CardService.newDecoratedText()
        .setTopLabel("AI-generated risk assessment")
        .setText(
          '<font color="' + verdictColor + '"><b>' +
          assessment.risk_score + " / 100 · " +
          escapeText(assessment.verdict) +
          "</b></font>"
        )
        .setBottomLabel("Not a probability or guarantee.")
        .setWrapText(true)
    )
    .addWidget(
      CardService.newTextParagraph()
        .setText(
          "<b>Why this result</b><br>" +
          escapeText(assessment.explanation)
        )
    );

  const evidenceSection = CardService.newCardSection()
    .setHeader("Evidence from this email")
    .addWidget(
      CardService.newTextParagraph()
        .setText(formatItems(assessment.evidence))
    );

  const limitationsSection = CardService.newCardSection()
    .setHeader("What this analysis did not verify")
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(1)
    .addWidget(
      CardService.newTextParagraph()
        .setText(
          '<font color="#5f6368">' +
          "This assessment used only the supplied email content." +
          "</font>"
        )
    )
    .addWidget(
      CardService.newTextParagraph()
        .setText(formatItems(assessment.limitations))
    );

  return [
    assessmentSection,
    evidenceSection,
    buildGuidanceSection(assessment.verdict),
    limitationsSection
  ];
}

function buildGuidanceSection(verdict) {
  let guidance;

  if (verdict === "High risk") {
    guidance =
      "<b>Do not act on this message yet.</b><br>" +
      "Avoid its links and attachments. Verify the request using a phone " +
      "number, website, or address you already trust—not contact details " +
      "provided in this email.";
  } else if (verdict === "Suspicious") {
    guidance =
      "<b>Pause and verify before acting.</b><br>" +
      "Confirm the sender and request through a known channel. Avoid links, " +
      "attachments, payments, or credential entry until verified.";
  } else {
    guidance =
      "<b>No strong warning signs were found in the supplied content.</b><br>" +
      "This does not guarantee safety. Stay cautious with unexpected links, " +
      "attachments, payments, or requests for credentials.";
  }

  return CardService.newCardSection()
    .setHeader("Recommended next step")
    .addWidget(
      CardService.newTextParagraph()
        .setText(guidance)
    );
}

function getVerdictColor(verdict) {
  if (verdict === "High risk") {
    return "#d93025";
  }
  if (verdict === "Suspicious") {
    return "#b06000";
  }
  return "#188038";
}

function extractLinks(html, plainText) {
  const links = [];
  const seen = new Set();

  function addLink(value) {
    const link = String(value)
      .replace(/&amp;/g, "&")
      .replace(/[),.;]+$/, "")
      .slice(0, 2048);

    if (/^https?:\/\//i.test(link) && !seen.has(link) && links.length < 30) {
      seen.add(link);
      links.push(link);
    }
  }

  const hrefPattern = /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  let match;
  while ((match = hrefPattern.exec(html)) !== null && links.length < 30) {
    addLink(match[1]);
  }

  const plainLinks = plainText.match(/https?:\/\/[^\s<>"']+/gi) || [];
  plainLinks.forEach(addLink);

  return links;
}

function formatItems(items) {
  if (!items.length) {
    return "(None provided)";
  }

  return "• " + items.map(escapeText).join("<br>• ");
}

// Display email text literally instead of treating it as card markup.
function escapeText(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}