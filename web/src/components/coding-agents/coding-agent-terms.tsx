const LINK = 'underline underline-offset-4 hover:text-foreground';

/** Who may use a subscription, with the providers' terms that say so. */
export function CodingAgentTerms() {
  return (
    <>
      Use your own Claude or ChatGPT subscription only on an agent nobody else uses.{' '}
      <a
        className={LINK}
        href="https://code.claude.com/docs/en/legal-and-compliance"
        target="_blank"
        rel="noopener noreferrer"
      >
        Anthropic's
      </a>{' '}
      and{' '}
      <a
        className={LINK}
        href="https://openai.com/policies/row-terms-of-use/"
        target="_blank"
        rel="noopener noreferrer"
      >
        OpenAI's
      </a>{' '}
      terms let only the subscriber use it, and a shared agent can get your account blocked.
    </>
  );
}
