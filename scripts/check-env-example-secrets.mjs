import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const protectedKeys = new Set([
  'ADMIN_EMAILS',
  'AFRICASTALKING_API_KEY',
  'AUTH_ALERT_SLACK_WEBHOOK_URL',
  'AUTH_ALERT_WEBHOOK_URL',
  'JWT_SECRET',
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_PASSKEY',
  'RESEND_API_KEY',
]);

const secretPatterns = [
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GitHub token', /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['Resend API key', /\bre_[A-Za-z0-9_-]{20,}\b/],
  ['Slack webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/],
  ['Stripe secret key', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
];

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && ['"', "'"].includes(trimmed[0])) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function findSecretViolations(contents) {
  const violations = [];

  contents.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;

    const [, key, rawValue] = match;
    const value = unquote(rawValue);
    if (protectedKeys.has(key) && value) {
      violations.push(`line ${index + 1}: ${key} must be empty`);
    }

    for (const [name, pattern] of secretPatterns) {
      if (pattern.test(value)) {
        violations.push(`line ${index + 1}: ${key} contains a ${name}`);
      }
    }
  });

  return violations;
}

async function main() {
  const filePath = process.argv[2] || '.env.example';
  const contents = await readFile(filePath, 'utf8');
  const violations = findSecretViolations(contents);

  if (violations.length) {
    console.error(`${filePath} contains values that must not be committed:`);
    violations.forEach((violation) => console.error(`- ${violation}`));
    process.exitCode = 1;
    return;
  }

  console.log(`${filePath} passed the secret check.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Secret check failed: ${error.message}`);
    process.exitCode = 1;
  });
}