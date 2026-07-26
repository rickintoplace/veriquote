#!/usr/bin/env node
/**
 * Prints the EVI1 citation instructions to embed in the answering/synthesizer
 * system prompt, so the model emits the verbatim-quote appendix that
 * verify-citations checks. Pipe or append the output into your prompt.
 *
 *   node bin/print-citation-instructions.mjs >> synth-system-prompt.txt
 */
import { buildCitationInstructions } from 'veriquote';

process.stdout.write(buildCitationInstructions() + '\n');
