/**
 * Canonical instruction block for the answering model. Inject the returned
 * text into the system prompt of any assistant that receives numbered web
 * sources, then verify its output with `verifyAnswer`.
 */

export interface CitationPromptOptions {
  /** Maximum number of cited sentences/bullets per answer. Default 15. */
  maxCitedClaims?: number;
  /** Maximum citations per sentence/bullet. Default 2. */
  maxCitationsPerClaim?: number;
  /** Preferred quote length range in characters. Default [80, 240]. */
  quoteLengthRange?: [number, number];
  /** Minimum quote length in characters (with stated exceptions). Default 60. */
  minQuoteLength?: number;
}

/** Build the EVI1 citation instruction block for the answering model. */
export function buildCitationInstructions(options: CitationPromptOptions = {}): string {
  const {
    maxCitedClaims = 15,
    maxCitationsPerClaim = 2,
    quoteLengthRange = [80, 240],
    minQuoteLength = 60,
  } = options;

  return `
[CITATION BUDGET]
- Keep citations sparse. Only cite new, load-bearing information.
- Maximum cited sentences/bullets: ${maxCitedClaims} total in the entire answer.
- Maximum citations per cited sentence/bullet: ${maxCitationsPerClaim}. Prefer 1.
- Prefer citing only:
  (1) key numeric results/effect sizes,
  (2) central conclusions,
  (3) safety-critical claims,
  (4) definitions that are not common knowledge.
- Everything else should be uncited explanation/synthesis.

[CITATIONS - inline markers]
- Cite sources inline using numeric markers like [n] immediately after the exact sentence/bullet they support.
- Multiple citations are written as [1][3] (no commas, no spaces).
- NEVER cite a source that does not directly support the statement in that sentence/bullet.
- NEVER invent sources. Only use the provided indices.
- Do NOT add a "Sources" section at the end. Citations must appear inline only.

[CLAIM MARKERS - stable mapping (MANDATORY)]
- A citation group of one or more markers like [n] or [n][m] must be immediately
  followed by a claim marker {cX} with no characters in between.
  Example: "...water expands when freezing.[2]{c1}"
  Example: "...water expands when freezing.[2][5]{c1}"
  Bad: "...freezing.[2] {c1}"
  Bad: "...freezing.[2].{c1}"
- Every sentence OR bullet that contains citations MUST end with exactly ONE claim marker {cX}.
- X starts at 1 and increases by 1 for each new cited sentence/bullet in THIS answer.
- Do NOT place {cX} anywhere else. Uncited sentences get no claim marker.

[QUOTE-BASED EVIDENCE APPENDIX (MANDATORY)]
After you finish the answer, append an appendix:
- Start with a line containing exactly: EVI1
- Then output one line per (claim, source) pair in this exact format:
  cX|n|"QUOTE"
- End with a line containing exactly: END_EVI1
- Do NOT output anything after END_EVI1.
- Do NOT wrap EVI1..END_EVI1 in code fences or markdown.

[COMPLETENESS RULES (MANDATORY)]
- For EVERY cited sentence/bullet {cX}, include an EVI1 line for EACH cited source index [n].
  Example: if the text contains "...[2][5]{c3}", EVI1 MUST contain both:
  c3|2|"..."
  c3|5|"..."
- If you cannot provide a verbatim quote for a citation, REMOVE that citation
  from the answer. Never leave a citation unverified.

Rules for QUOTE:
- QUOTE must be copied verbatim from the provided source TEXT (not paraphrased).
- QUOTE must be sufficient to support the claim; prefer the shortest quote that
  still supports it (typically ${quoteLengthRange[0]}-${quoteLengthRange[1]} characters).
- QUOTE must be at least ${minQuoteLength} characters unless it contains a numeric result or is
  a complete standalone sentence that uniquely supports the claim.
- QUOTE must be a single line: escape newlines as \\n and double quotes as \\".

[SCOPE AND STRENGTH DISCIPLINE (MANDATORY)]
- A cited claim must match its quote in meaning, scope, and outcome/topic. If the
  quote discusses a different outcome, rewrite the claim or drop the citation.
- Never expand categories beyond what the quote explicitly states.
- Never infer missing definitions; if a key term is not defined in the provided
  text, keep the statement generic or label it as unclear.
- Use absolute words ("proves", "always", "never") only when the quote clearly
  supports that strength. Do not upgrade hedged evidence ("may", "associated")
  to certainty.
- Prefer sources whose provided text shows the methods/assumptions behind a
  claim; when only conclusions are visible, use cautious language.

IMPORTANT:
- The user-facing answer must end BEFORE the EVI1 appendix starts.
- The appendix is required only when you used citations. If you used no
  citations, do NOT output EVI1/END_EVI1.
`.trim();
}
